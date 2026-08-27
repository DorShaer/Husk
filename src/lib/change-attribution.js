'use strict';

// Who changed these files, answered at the only two strengths Husk can honestly
// give, plus a floor of saying nothing.
//
//   run     a retained autopilot run recorded this exact path. Husk wrote that
//           record, so this is authorship.
//   window  a live session's directory contains the repository and the file was
//           written at or after that session started. This is a time overlap,
//           never an author. Its since is the earliest qualifying session
//           start, so the window shown is the whole span the change could sit
//           in and no candidate session is left out of it.
//   none    everything else, including a path with no readable mtime.
//
// Only tier 'run' carries a runId and a goal. Every other tier answers with
// both fields null, so a caller has nothing to render an authorship claim from.

function normPath(p) {
  let s = String(p).replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// True when inner sits at or under outer.
function contains(outer, inner) {
  if (typeof outer !== 'string' || typeof inner !== 'string' || !outer || !inner) return false;
  const a = normPath(outer);
  const b = normPath(inner);
  return a === b || b.startsWith(a.endsWith('/') ? a : a + '/');
}

function isMs(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function relOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rel = typeof entry.rel === 'string' && entry.rel ? entry.rel
    : (typeof entry.path === 'string' && entry.path ? entry.path : null);
  return rel ? normPath(rel) : null;
}

// The paths one run record names. A record carries them as its changes list, as
// a files list, or as a plain array of paths.
function runPaths(run) {
  const out = [];
  const lists = [run && run.changes, run && run.files, run && run.paths];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string' && item) out.push(normPath(item));
      else if (item && typeof item === 'object' && typeof item.path === 'string' && item.path) out.push(normPath(item.path));
    }
  }
  return out;
}

function runIdOf(run) {
  if (!run || typeof run !== 'object') return null;
  if (typeof run.runId === 'string' && run.runId) return run.runId;
  if (typeof run.id === 'string' && run.id) return run.id;
  return null;
}

function runTimeOf(run) {
  if (!run || typeof run !== 'object') return null;
  if (isMs(run.endedAtMs)) return run.endedAtMs;
  const ended = Date.parse(run.endedAt);
  if (Number.isFinite(ended)) return ended;
  if (isMs(run.startedAtMs)) return run.startedAtMs;
  return null;
}

// path -> [{ runId, goal, since }], one entry per run that named it.
function indexRuns(runs) {
  const index = new Map();
  if (!Array.isArray(runs)) return index;
  for (const run of runs) {
    const runId = runIdOf(run);
    if (!runId) continue;
    const claim = {
      runId,
      goal: typeof run.goal === 'string' && run.goal ? run.goal : null,
      since: runTimeOf(run),
    };
    for (const p of runPaths(run)) {
      const list = index.get(p);
      if (list) list.push(claim);
      else index.set(p, [claim]);
    }
  }
  return index;
}

// Sessions that could have written into this repository: a live session whose
// directory contains the root and which started at a time this machine can read.
function usableSessions(sessions, root, now) {
  const out = [];
  if (!Array.isArray(sessions) || typeof root !== 'string' || !root) return out;
  for (const s of sessions) {
    if (!s || typeof s !== 'object') continue;
    const startedAt = isMs(s.startedAt) ? s.startedAt : null;
    if (startedAt === null || startedAt > now) continue;
    if (!contains(s.cwd, root)) continue;
    out.push(startedAt);
  }
  return out;
}

function claimNone() {
  return { tier: 'none', runId: null, goal: null, since: null, ambiguous: false };
}

// attribute({ entries, runs, sessions, root, now }) -> Map of rel to a claim.
// entries are the changed files, each with a rel or path and an mtimeMs. root
// is the repository root the sessions are measured against; without it no
// session can be shown to reach this repository and the window tier is closed.
function attribute(input) {
  const arg = input && typeof input === 'object' ? input : {};
  const entries = Array.isArray(arg.entries) ? arg.entries : [];
  const now = isMs(arg.now) ? arg.now : Date.now();
  const byPath = indexRuns(arg.runs);
  const starts = usableSessions(arg.sessions, arg.root, now);

  const out = new Map();
  for (const entry of entries) {
    const rel = relOf(entry);
    if (!rel) continue;

    const claims = byPath.get(rel);
    if (claims && claims.length) {
      out.set(rel, {
        tier: 'run',
        runId: claims[0].runId,
        goal: claims[0].goal,
        since: claims[0].since,
        ambiguous: claims.length > 1,
      });
      continue;
    }

    const mtimeMs = entry && isMs(entry.mtimeMs) ? entry.mtimeMs : null;
    if (mtimeMs === null) {
      out.set(rel, claimNone());
      continue;
    }

    const overlapping = starts.filter((startedAt) => mtimeMs >= startedAt);
    if (!overlapping.length) {
      out.set(rel, claimNone());
      continue;
    }

    out.set(rel, {
      tier: 'window',
      runId: null,
      goal: null,
      // The earliest qualifying start, so every session that could have
      // written this file sits inside the window the claim reports.
      since: Math.min(...overlapping),
      ambiguous: overlapping.length > 1,
    });
  }
  return out;
}

module.exports = { attribute };
