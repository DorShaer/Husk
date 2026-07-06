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
// The supervisor itself is fs + state + callbacks; it does NOT
// spawn child processes or read PTY streams. Those concerns belong
// to main.js where node-pty and Electron live. The supervisor
// receives parsed "events" through the recordEvent method and
// returns wall-clock ticks through tickClock. This separation
// keeps the orchestrator unit-testable without spawning anything.

const path = require('path');
const Snapshot = require('./snapshot');
const Audit = require('./audit');
const Budget = require('./budget');
const Progress = require('./progress');

// A stable action signature for loop detection. Returns a string only
// when the event carries an identifiable action (a command, tool, or
// file the agent is acting on); returns null otherwise so loop
// detection never trips on generic chatter that merely shares a kind.
function actionSignature(event) {
  if (!event || typeof event !== 'object') return null;
  const p = event.payload;
  const id = p && typeof p === 'object'
    ? (p.command || p.tool || p.file || p.path || p.action || null)
    : null;
  if (!id) return null;
  return `${event.kind || 'event'}:${String(id)}`;
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

  // 1. capture pre-run snapshot. Caller may set opts.skipSnapshot when
  // it has already produced the snapshot off the main thread (Electron
  // main.js uses Snapshot.captureSnapshotAsync to keep the UI from
  // freezing while a large workspace is walked).
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

  // 3b. progress governor (opt-in). Detects idle / loop / no-progress
  // stalls so a run that is burning wall-clock and tokens without doing
  // useful work is halted early. Off unless the caller opts in, so the
  // budget-only behaviour stays unchanged for callers that do not want
  // the governor.
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
    // Feed the progress governor: agent output keeps the run "alive"
    // (resets idle) and an identifiable action feeds loop detection.
    if (governor) {
      // Output can arrive as event.tokens.chars (token-bearing events) or
      // event.payload.chars (the agent_output flush row). Either counts as
      // the run being alive and resets the idle clock.
      const chars = (event.tokens && Number.isFinite(event.tokens.chars)) ? event.tokens.chars
        : (event.payload && Number.isFinite(event.payload.chars)) ? event.payload.chars
        : undefined;
      governor.tick({
        now: now(),
        charsFromAgent: chars,
        signature: actionSignature(event),
        diffSignature: typeof event.diffSignature === 'string' ? event.diffSignature : undefined,
      });
    }
    // Check caps after every event. The supervisor's pattern is
    // "record then halt", so the triggering event stays in the
    // log; the halt_budget event appears AFTER it. Budget (hard spend)
    // is checked before the governor (waste) so a run that hit both
    // reports the budget cap it truly crossed.
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
    // A pure clock tick with no output is exactly how an idle stall is
    // caught: the governor sees time advance with no charsFromAgent.
    if (governor) {
      governor.tick({ now: now() });
      const g = governor.state(now());
      if (g.stalled) halt('stall', { signal: g.stalled, progress: g, meter: s });
    }
    return s;
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

  // Async twin of endRun. Same audit ordering, but the end-of-run diff
  // is computed with the async walker so the Electron main thread is
  // never frozen hashing a large workspace at run end.
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
      // Live governor state (idle / loop / no-progress ratios and the
      // tripped signal, if any) so the fleet strip can render a run as
      // "healthy" vs "stalling" without re-deriving it. Null when the
      // governor is not enabled for this run.
      governorState: () => (governor ? governor.state(now()) : null),
      // Exposed so the supervisor can feed the agent's own reported
      // token count (parsed from its status line by the renderer)
      // into the meter and override the chars/4 estimate.
      setReportedTokens: (n) => budget.setReportedTokens(n),
      // Exact per-turn deltas from a structured transcript (real new
      // input + generated output, cache reads excluded). The truthful
      // signal: sums to what the run actually consumed.
      addTokens: (inp, out) => budget.tick({ inputTokens: inp, outputTokens: out }),
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
  // Pull the most recent run_summary AND the original start_run row.
  // run_summary carries the final meter / diff; start_run carries the
  // goal + caps the user originally set. Both are needed for Review +
  // Rerun (review shows the goal; rerun pre-fills the modal with goal
  // and caps).
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
