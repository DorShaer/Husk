'use strict';

// Race judge: rank the runs of one race (N agents on the same task) and suggest
// a winner. Transparent by design, never opaque. Neutrality is the point of
// Race Mode: the ranking uses only outcome metrics, never the agent's name, so
// the same metrics always produce the same rank regardless of which agent
// produced them. The suggested winner is a hint; the operator decides.
//
// Each input run is expected to carry:
//   { runId, agent, changes: [ ... ], metrics: { durationMs, tokens, dollars, fileCount } }
// changes is the file-change list; fileCount falls back to changes.length.

function num(v, dflt) {
  return typeof v === 'number' && isFinite(v) ? v : dflt;
}

function fileCountOf(run) {
  const m = run && run.metrics;
  if (m && typeof m.fileCount === 'number' && isFinite(m.fileCount)) return m.fileCount;
  return Array.isArray(run && run.changes) ? run.changes.length : 0;
}
function durationOf(run) { return num(run && run.metrics && run.metrics.durationMs, Infinity); }
function dollarsOf(run) { return num(run && run.metrics && run.metrics.dollars, Infinity); }
function tokensOf(run) { return num(run && run.metrics && run.metrics.tokens, Infinity); }

// A run can only win a coding race if it actually produced changes. A zero-diff
// run (the agent did nothing, or only talked) is never a winner.
function hasChanges(run) { return fileCountOf(run) > 0; }

// Rank runs best-first. Default heuristic among runs that made changes:
//   1. fewer files changed  (more surgical)
//   2. then cheaper         (lower dollars)
//   3. then faster          (lower duration)
// Runs with no changes always sort last. Ties fall back to original index so
// the sort is stable and deterministic. Every run gets a plain-language reason
// and per-metric "best in this race" flags; exactly one changed run is marked
// suggested (the winner hint).
function rankRuns(runs) {
  if (!Array.isArray(runs) || !runs.length) return [];
  const enriched = runs.map((run, index) => ({
    run,
    index,
    fileCount: fileCountOf(run),
    durationMs: durationOf(run),
    dollars: dollarsOf(run),
    tokens: tokensOf(run),
    changed: hasChanges(run),
  }));

  const changedOnly = enriched.filter((e) => e.changed);
  const minBy = (arr, sel) => (arr.length ? arr.reduce((a, b) => (sel(b) < sel(a) ? b : a)) : null);
  const fastest = minBy(changedOnly, (e) => e.durationMs);
  const cheapest = minBy(changedOnly, (e) => e.dollars);
  const smallest = minBy(changedOnly, (e) => e.fileCount);

  enriched.sort((a, b) => {
    if (a.changed !== b.changed) return a.changed ? -1 : 1;
    if (a.changed) {
      if (a.fileCount !== b.fileCount) return a.fileCount - b.fileCount;
      if (a.dollars !== b.dollars) return a.dollars - b.dollars;
      if (a.durationMs !== b.durationMs) return a.durationMs - b.durationMs;
    }
    return a.index - b.index; // stable tie-break
  });

  return enriched.map((e, rank) => {
    const isFastest = fastest != null && e.run === fastest.run;
    const isCheapest = cheapest != null && e.run === cheapest.run;
    const isSmallest = smallest != null && e.run === smallest.run;
    const suggested = e.changed && rank === 0;
    let reason;
    if (!e.changed) reason = 'Made no changes; cannot win.';
    else {
      const bits = [];
      if (isSmallest) bits.push('most surgical');
      if (isCheapest) bits.push('cheapest');
      if (isFastest) bits.push('fastest');
      reason = bits.length ? ('Best on: ' + bits.join(', ') + '.') : `Changed ${e.fileCount} file${e.fileCount === 1 ? '' : 's'}.`;
    }
    return {
      ...e.run,
      rank,
      suggested,
      isFastest,
      isCheapest,
      isSmallest,
      fileCount: e.fileCount,
      reason,
    };
  });
}

// The suggested winner of a race, or null if no run made changes.
function pickWinner(runs) {
  const ranked = rankRuns(runs);
  return ranked.find((r) => r.suggested) || null;
}

module.exports = { rankRuns, pickWinner };
