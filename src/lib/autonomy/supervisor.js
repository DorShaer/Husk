'use strict';

// Husk Autonomy Mode supervisor.
//
// Owns the lifecycle of one run end-to-end:
//   1. snapshot the workspace
//   2. start the budget meter
//   3. open the audit log
//   4. spawn the CLI (caller-provided)
//   5. on each tick: feed the parsed event stream into the audit
//      log AND the budget meter; if the meter reports a hit cap,
//      halt the run
//   6. on halt: write a halt event into the audit log, compute the
//      end-of-run diff against the snapshot, and surface it
//
// The supervisor is fs + state + callbacks; spawning child processes and
// reading PTY streams belong to main.js, where node-pty and Electron live.
// It receives parsed "events" through recordEvent and wall-clock ticks
// through tickClock.

const path = require('path');
const crypto = require('crypto');
const Snapshot = require('./snapshot');
const Audit = require('./audit');
const Budget = require('./budget');
const Progress = require('./progress');
// Shared canonical serializer: loop detection here and the workflow
// artifact fingerprint both hash with it.
const { stableJson } = require('../stable-json');

// A stable action signature for loop detection. Returns a string only when
// the event carries an identifiable action (a command, tool, or file the
// agent is acting on), and null otherwise.
function actionSignature(event) {
  if (!event || typeof event !== 'object') return null;
  const p = event.payload;
  const hasAction = p && typeof p === 'object'
    && (p.command || p.tool || p.file || p.file_path || p.path || p.action || p.pattern || p.prompt);
  const id = hasAction ? stableHash(p) : null;
  if (!id) return null;
  return `${event.kind || 'event'}:${id}`;
}

function stableHash(value) {
  const json = stableJson(value);
  if (!json || json === '{}') return null;
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function startRun(opts = {}) {
  const sessionId = String(opts.sessionId || '').trim();
  const workspaceRoot = String(opts.workspaceRoot || '').trim();
  const storageRoot = String(opts.storageRoot || '').trim();
  if (!sessionId || !workspaceRoot || !storageRoot) {
    return { ok: false, error: 'sessionId, workspaceRoot, storageRoot required' };
  }
  if (!path.isAbsolute(workspaceRoot)) return { ok: false, error: 'workspaceRoot must be absolute' };
  if (!path.isAbsolute(storageRoot)) return { ok: false, error: 'storageRoot must be absolute' };

  const encrypt = typeof opts.encrypt === 'function' ? opts.encrypt : null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  // 1. capture pre-run snapshot. opts.skipSnapshot marks a snapshot the
  // caller already produced off the main thread with captureSnapshotAsync.
  let snap;
  if (opts.skipSnapshot === true) {
    snap = { ok: true, manifest: opts.snapshotManifest || null };
  } else {
    snap = Snapshot.captureSnapshot(workspaceRoot, storageRoot, sessionId, {
      encrypt,
      ignore: opts.ignore,
    });
  }
  if (!snap.ok) return { ok: false, error: `snapshot failed: ${snap.error}` };

  // 2. open audit log
  const auditRes = Audit.createAuditLog(storageRoot, sessionId, {
    encrypt,
    maxInlineBytes: opts.maxInlineBytes,
    now: () => new Date(now()).toISOString(),
  });
  if (!auditRes.ok) return { ok: false, error: `audit open failed: ${auditRes.error}` };
  const auditWriter = auditRes.writer;

  // 3. budget meter
  const budget = Budget.createBudgetMeter({
    startedAt: now(),
    caps: opts.caps,
    modelId: opts.modelId,
    rates: opts.rates,
  });

  // 3b. progress governor (opt-in). Halts a run on idle, loop, and
  // no-progress signals. Without it, halting is budget-only.
  const governor = opts.governor
    ? Progress.createProgressMeter({
        startedAt: now(),
        thresholds: (opts.governor === true ? null : opts.governor.thresholds),
      })
    : null;

  // 4. write the start_run event
  auditWriter.append({
    kind: 'start_run',
    agent: opts.agent || null,
    payload: {
      goal: typeof opts.goal === 'string' ? opts.goal : null,
      caps: budget.state(now()).caps,
      modelId: opts.modelId || null,
      workspaceRoot,
    },
  });

  // Mutable state for the run.
  const state = {
    sessionId,
    workspaceRoot,
    storageRoot,
    status: 'running',           // running | halted | cancelled
    haltReason: null,
    haltDetail: null,
    startedAt: now(),
    endedAt: null,
    turnCount: 0,
  };

  function recordEvent(event = {}) {
    if (state.status !== 'running') {
      return { ok: false, error: 'run is not active' };
    }
    if (Number.isFinite(event.turn) && event.turn > state.turnCount) state.turnCount = event.turn;
    // Tokens may ride alongside the event; feed them into the meter.
    if (event.tokens) {
      budget.tick({
        now: now(),
        inputTokens: event.tokens.input,
        outputTokens: event.tokens.output,
        charsFromAgent: event.tokens.chars,
      });
    } else {
      // Pure clock tick so wall-clock cap still ticks even on
      // events without token deltas.
      budget.tick({ now: now() });
    }
    auditWriter.append({
      kind: event.kind,
      agent: event.agent || null,
      turn: event.turn,
      ts: event.ts,
      payload: event.payload,
    });
    // Feed the progress governor: agent output resets the idle clock and an
    // identifiable action feeds loop detection.
    if (governor) {
      // Output arrives as event.tokens.chars on token-bearing events or
      // event.payload.chars on the agent_output flush row.
      const chars = (event.tokens && Number.isFinite(event.tokens.chars)) ? event.tokens.chars
        : (event.payload && Number.isFinite(event.payload.chars)) ? event.payload.chars
        : undefined;
      governor.tick({
        now: now(),
        charsFromAgent: chars,
        signature: actionSignature(event),
        diffSignature: typeof event.diffSignature === 'string' ? event.diffSignature : undefined,
        totalTokens: budget.state(now()).totalTokens,
      });
    }
    // Check caps after every event: record then halt, so the triggering
    // event sits in the log ahead of the halt row. Budget is checked before
    // the governor, so a run that hits both reports the budget cap.
    const meterState = budget.state(now());
    if (meterState.hitCap) {
      halt('budget', { cap: meterState.hitCap, meter: meterState });
    } else if (governor) {
      const g = governor.state(now());
      if (g.stalled) halt('stall', { signal: g.stalled, progress: g, meter: meterState });
    }
    return { ok: true, meterState };
  }

  function tickClock() {
    if (state.status !== 'running') return budget.state(now());
    budget.tick({ now: now() });
    const s = budget.state(now());
    if (s.hitCap) {
      halt('budget', { cap: s.hitCap, meter: s });
      return s;
    }
    // Feed the clock and the current token total so the governor can measure
    // token burn against a frozen diff. The diff signature itself arrives
    // out of band via reportProgress().
    if (governor) {
      governor.tick({ now: now(), totalTokens: s.totalTokens });
      const g = governor.state(now());
      if (g.stalled) halt('stall', { signal: g.stalled, progress: g, meter: s });
    }
    return s;
  }

  // Feed the governor a workspace-diff signature. main.js computes the diff
  // off-thread and calls this periodically; a change in the signature is the
  // forward-progress signal that resets the governor's waste timers.
  function reportProgress(diffSignature) {
    if (!governor || state.status !== 'running') return null;
    if (typeof diffSignature !== 'string') return governor.state(now());
    governor.tick({ now: now(), diffSignature, totalTokens: budget.state(now()).totalTokens });
    const g = governor.state(now());
    if (g.stalled) halt('stall', { signal: g.stalled, progress: g, meter: budget.state(now()) });
    return g;
  }

  function halt(reason, detail) {
    if (state.status !== 'running') return;
    state.status = 'halted';
    state.haltReason = reason;
    state.haltDetail = detail || null;
    state.endedAt = now();
    auditWriter.append({
      kind: 'halt_' + reason,
      payload: detail || null,
    });
  }

  function cancel(detail) {
    if (state.status !== 'running') return;
    state.status = 'cancelled';
    state.haltReason = 'user';
    state.haltDetail = detail || null;
    state.endedAt = now();
    auditWriter.append({ kind: 'halt_user', payload: detail || null });
  }

  function endRun(detail) {
    if (state.status === 'running') {
      state.status = 'ended';
      state.haltReason = 'natural';
      state.haltDetail = detail || null;
      state.endedAt = now();
      auditWriter.append({ kind: 'end_run', payload: detail || null });
    }
    // Compute the diff against the pre-run snapshot and append a
    // run_summary record so a single tail of the log surfaces what
    // changed during the run.
    const diff = Snapshot.diffWorkspace(workspaceRoot, storageRoot, sessionId, { ignore: opts.ignore });
    auditWriter.append({
      kind: 'run_summary',
      payload: {
        turnCount: state.turnCount,
        status: state.status,
        haltReason: state.haltReason,
        haltDetail: state.haltDetail,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        durationMs: state.endedAt ? state.endedAt - state.startedAt : 0,
        diff: diff.ok ? diff.changes : [],
        meter: budget.state(now()),
      },
    });
  }

  // Async twin of endRun. Same audit ordering, with the end-of-run diff
  // computed by the async walker so the Electron main thread keeps running
  // while a large workspace is hashed.
  async function endRunAsync(detail) {
    if (state.status === 'running') {
      state.status = 'ended';
      state.haltReason = 'natural';
      state.haltDetail = detail || null;
      state.endedAt = now();
      auditWriter.append({ kind: 'end_run', payload: detail || null });
    }
    let diff;
    try {
      diff = await Snapshot.diffWorkspaceAsync(workspaceRoot, storageRoot, sessionId, { ignore: opts.ignore });
    } catch (_) { diff = { ok: false, changes: [] }; }
    auditWriter.append({
      kind: 'run_summary',
      payload: {
        turnCount: state.turnCount,
        status: state.status,
        haltReason: state.haltReason,
        haltDetail: state.haltDetail,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        durationMs: state.endedAt ? state.endedAt - state.startedAt : 0,
        diff: diff.ok ? diff.changes : [],
        meter: budget.state(now()),
      },
    });
  }

  function snapshotOnly() { return snap.manifest; }
  function getState() { return Object.assign({}, state); }

  return {
    ok: true,
    runner: {
      sessionId,
      workspaceRoot,
      storageRoot,
      auditWriter,
      recordEvent,
      tickClock,
      halt,
      cancel,
      endRun,
      endRunAsync,
      getState,
      snapshotManifest: snapshotOnly,
      budgetState: () => budget.state(now()),
      // Live governor state: idle, loop, and no-progress ratios plus the
      // tripped signal, for the fleet strip. Null when the governor is off.
      governorState: () => (governor ? governor.state(now()) : null),
      // Feed a workspace-diff signature to the governor (forward-progress
      // signal). main.js computes the diff off-thread and calls this.
      reportProgress: (diffSignature) => reportProgress(diffSignature),
      // Feed the current action signature to the governor (loop detection).
      // main.js calls this from the transcript tool-use parser, off the
      // audit path.
      reportAction: (signature) => {
        if (!governor || state.status !== 'running') return null;
        if (typeof signature !== 'string' || !signature) return governor.state(now());
        governor.tick({ now: now(), signature, totalTokens: budget.state(now()).totalTokens });
        const g = governor.state(now());
        if (g.stalled) halt('stall', { signal: g.stalled, progress: g, meter: budget.state(now()) });
        return g;
      },
      // Feed the agent's own reported token count, parsed from its status
      // line by the renderer, so the meter uses it over the chars/4 estimate.
      setReportedTokens: (n) => budget.setReportedTokens(n),
      // Re-pin the billing rate to the model the transcript reports for
      // this turn.
      setModel: (id) => { try { budget.setModel(id); } catch (_) {} },
      // Exact per-turn deltas from a structured transcript: new input and
      // generated output, cache reads excluded.
      addTokens: (inp, out) => budget.tick({ inputTokens: inp, outputTokens: out }),
      // Exact per-turn usage from a structured transcript: fresh input,
      // output, cache writes, and cache reads billed at their own rates.
      addUsage: (u = {}) => budget.tick({
        inputTokens: u.input,
        outputTokens: u.output,
        cacheCreateTokens: u.cacheCreate,
        cacheReadTokens: u.cacheRead,
      }),
    },
  };
}

// revertRun applies the snapshot back to the workspace, effectively
// rolling back everything the agent did. Returns the count of paths
// touched plus any warnings emitted by the restore.
function revertRun(opts = {}) {
  const sessionId = String(opts.sessionId || '').trim();
  const workspaceRoot = String(opts.workspaceRoot || '').trim();
  const storageRoot = String(opts.storageRoot || '').trim();
  if (!sessionId || !workspaceRoot || !storageRoot) {
    return { ok: false, error: 'sessionId, workspaceRoot, storageRoot required' };
  }
  const decrypt = typeof opts.decrypt === 'function' ? opts.decrypt : null;
  return Snapshot.restoreFromSnapshot(workspaceRoot, storageRoot, sessionId, {
    decrypt,
    preserveExtras: opts.preserveExtras === true,
    ignore: opts.ignore,
  });
}

// summarizeRun reads the audit log and the snapshot manifest, returns
// a serializable summary that the renderer can paint into the
// status panel and the Run Review modal.
function summarizeRun(opts = {}) {
  const sessionId = String(opts.sessionId || '').trim();
  const workspaceRoot = String(opts.workspaceRoot || '').trim();
  const storageRoot = String(opts.storageRoot || '').trim();
  if (!sessionId || !storageRoot) {
    return { ok: false, error: 'sessionId, storageRoot required' };
  }
  const decrypt = typeof opts.decrypt === 'function' ? opts.decrypt : null;
  const audit = Audit.readAuditLog(storageRoot, sessionId, { decrypt });
  if (!audit.ok) return { ok: false, error: audit.error };
  let diff = { ok: false, changes: [] };
  if (workspaceRoot) {
    diff = Snapshot.diffWorkspace(workspaceRoot, storageRoot, sessionId);
  }
  const chain = Audit.verifyAuditChain(storageRoot, sessionId);
  return buildSummary(audit, diff, chain, Snapshot.hasSnapshot(storageRoot, sessionId));
}

// Async twin of summarizeRun: identical output, but the workspace diff
// is walked off the main thread.
async function summarizeRunAsync(opts = {}) {
  const sessionId = String(opts.sessionId || '').trim();
  const workspaceRoot = String(opts.workspaceRoot || '').trim();
  const storageRoot = String(opts.storageRoot || '').trim();
  if (!sessionId || !storageRoot) {
    return { ok: false, error: 'sessionId, storageRoot required' };
  }
  const decrypt = typeof opts.decrypt === 'function' ? opts.decrypt : null;
  const audit = Audit.readAuditLog(storageRoot, sessionId, { decrypt });
  if (!audit.ok) return { ok: false, error: audit.error };
  let diff = { ok: false, changes: [] };
  if (workspaceRoot) {
    try { diff = await Snapshot.diffWorkspaceAsync(workspaceRoot, storageRoot, sessionId); }
    catch (_) { diff = { ok: false, changes: [] }; }
  }
  const chain = Audit.verifyAuditChain(storageRoot, sessionId);
  return buildSummary(audit, diff, chain, Snapshot.hasSnapshot(storageRoot, sessionId));
}

// Shared shaping for both summarize variants.
function buildSummary(audit, diff, chain, hasSnapshot) {
  // Pull the most recent run_summary and the first start_run row.
  // run_summary carries the final meter and diff; start_run carries the goal
  // and caps set at run start, which Review and Rerun both read.
  let summary = null;
  for (let i = audit.records.length - 1; i >= 0; i--) {
    if (audit.records[i].kind === 'run_summary') { summary = audit.records[i].payload; break; }
  }
  let goal = null;
  let caps = null;
  for (const rec of audit.records) {
    if (rec.kind === 'start_run' && rec.payload) {
      if (typeof rec.payload.goal === 'string') goal = rec.payload.goal;
      if (rec.payload.caps && typeof rec.payload.caps === 'object') caps = rec.payload.caps;
      break;
    }
  }
  return {
    ok: true,
    eventCount: audit.records.length,
    summary,
    goal,
    caps,
    diff: diff.ok ? diff.changes : [],
    hasSnapshot: !!hasSnapshot,
    chain: { valid: chain.valid, brokenAtIndex: chain.brokenAtIndex },
    warnings: audit.warnings,
  };
}

module.exports = { startRun, revertRun, summarizeRun, summarizeRunAsync };
