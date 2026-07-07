'use strict';

// Fleet Receipt for Husk Autonomy Mode.
//
// A fleet session is N autonomous runs launched together. The receipt is
// the single shareable artifact that summarizes them: total spend, what
// landed, and -- the headline -- how much waste the governor caught. It
// is the tweetable proof ("6 agents, $2.14, 2 runaway loops killed before
// they burned $30") and, in the same object, one normalized corpus row
// per run: the seed of the cross-vendor outcome dataset a future router
// will learn from.
//
// Design rules (same contract as budget.js / progress.js):
//   - Pure: operates on plain row objects, no fs, no clock, no I/O. The
//     caller adapts supervisor summaries into rows via fromSummary().
//   - Honest numbers: the savings figure is an UPPER BOUND ("up to $X"),
//     never presented as exact. A stalled run is one the governor stopped
//     while it made no progress; absent the governor it would have kept
//     spending toward its hard cap. cap - spent is therefore the most it
//     could have wasted, which is the honest, defensible ceiling.

// Normalize one supervisor summary (buildSummary output) into a receipt
// row. agent / model are not carried in the audit summary, so the caller
// passes them (main.js knows each run's tool + model); everything else
// comes from the run's own recorded meter and diff.
function fromSummary(summary, extra = {}) {
  const s = (summary && summary.summary) || {};
  const meter = s.meter || {};
  const caps = (summary && summary.caps) || meter.caps || {};
  // Prefer the diff RECORDED in the run_summary at finish time: it is the
  // stable, finish-time truth. The live top-level diff (recomputed by
  // diffWorkspace at summarize time) goes empty once the worktree is applied
  // or discarded, which would misreport a landed run as changing nothing.
  const recordedDiff = Array.isArray(s.diff) ? s.diff : [];
  const liveDiff = Array.isArray(summary && summary.diff) ? summary.diff : [];
  const diff = recordedDiff.length ? recordedDiff : liveDiff;
  return {
    agent: extra.agent || null,
    model: extra.model || meter.modelId || null,
    goal: (summary && summary.goal) || null,
    status: s.status || 'unknown',           // running | ended | halted | cancelled | unknown
    haltReason: s.haltReason || null,         // natural | budget | stall | user | ...
    stallSignal: (s.haltDetail && s.haltDetail.signal) || null, // idle | loop | noProgress
    dollars: num(meter.dollars),
    tokens: num(meter.totalTokens),
    tokensEstimated: !!meter.tokensEstimated,
    durationMs: num(s.durationMs),
    filesChanged: diff.length,
    caps: {
      dollars: num(caps.dollars),
      tokens: num(caps.tokens),
      minutes: num(caps.minutes),
    },
  };
}

// Classify a row into one bucket for headline counts.
//   landed   -- finished on its own and actually changed files
//   empty    -- finished on its own but changed nothing
//   saved    -- the governor stopped a stalled (idle/loop/no-progress) run
//   capped   -- hit a hard budget cap (time/tokens/dollars)
//   stopped  -- the user cancelled it
//   running  -- still going
function classify(row) {
  if (row.status === 'running') return 'running';
  if (row.haltReason === 'stall') return 'saved';
  if (row.haltReason === 'budget') return 'capped';
  if (row.status === 'cancelled' || row.haltReason === 'user') return 'stopped';
  // ended / natural
  return row.filesChanged > 0 ? 'landed' : 'empty';
}

// Estimate the spend a stalled run would have incurred had the governor not
// stopped it. Only meaningful for 'saved' rows.
//
// Honesty rule: project the run's OWN realized cost rate forward. A run that
// has cost $0 so far -- a flat-rate Copilot/Codex/Aider/Gemini run, or one
// that barely started -- has NO provable dollar rate, so we never invent a
// dollar figure for it (that was the old bug: the default $5 cap made every
// vendor stall claim "up to $5 saved" out of thin air). Such runs report
// their token saving only, dollars 0.
//
//   remaining tokens = (token cap - spent), or derived from the dollar cap
//     at the realized rate when only a dollar cap exists.
//   saved dollars    = remaining tokens x realized $/token (0 if the run
//     itself cost nothing).
// horizonMs is how long a stalled UNCAPPED run would keep spinning before a
// human noticed; the burn caught is projected at the run's realized rate over
// that window. Only used when no cap bounds the projection.
function estimateSavings(row, horizonMs = 900000) {
  if (classify(row) !== 'saved') return { dollars: 0, tokens: 0, basis: 'none' };
  const spent$ = row.dollars;
  const spentTok = row.tokens;
  const perTok = spentTok > 0 ? spent$ / spentTok : 0;
  if (row.caps.tokens > 0) {
    const remainingTok = Math.max(0, row.caps.tokens - spentTok);
    return { dollars: round2(perTok * remainingTok), tokens: Math.round(remainingTok), basis: perTok > 0 ? 'projectedRate' : 'tokensOnly' };
  }
  if (row.caps.dollars > 0 && perTok > 0) {
    const remainingTok = Math.max(0, (row.caps.dollars - spent$) / perTok);
    return { dollars: round2(perTok * remainingTok), tokens: Math.round(remainingTok), basis: 'projectedRate' };
  }
  // No cap: project the realized burn rate over the unattended horizon.
  if (row.durationMs > 0 && (spent$ > 0 || spentTok > 0)) {
    const perMs$ = spent$ / row.durationMs;
    const perMsTok = spentTok / row.durationMs;
    return {
      dollars: round2(perMs$ * horizonMs),
      tokens: Math.round(perMsTok * horizonMs),
      basis: spent$ > 0 ? 'projectedRate' : 'tokensOnly',
    };
  }
  return { dollars: 0, tokens: 0, basis: 'none' };
}

// Aggregate rows into the fleet receipt.
function buildFleetReceipt(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const counts = { landed: 0, empty: 0, saved: 0, capped: 0, stopped: 0, running: 0 };
  const perAgent = new Map();
  let totalDollars = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;
  let savedDollars = 0;
  let savedTokens = 0;
  let anyEstimated = false;

  for (const row of list) {
    const bucket = classify(row);
    counts[bucket] += 1;
    totalDollars += row.dollars;
    totalTokens += row.tokens;
    totalDurationMs = Math.max(totalDurationMs, row.durationMs); // wall-clock: fleet runs in parallel
    if (row.tokensEstimated) anyEstimated = true;
    if (bucket === 'saved') {
      const sv = estimateSavings(row, opts.horizonMs);
      savedDollars += sv.dollars;
      savedTokens += sv.tokens;
    }
    const key = row.agent || 'unknown';
    const a = perAgent.get(key) || { agent: key, runs: 0, dollars: 0, tokens: 0 };
    a.runs += 1; a.dollars += row.dollars; a.tokens += row.tokens;
    perAgent.set(key, a);
  }

  const receipt = {
    runCount: list.length,
    totalDollars: round2(totalDollars),
    totalTokens,
    totalDurationMs,
    tokensEstimated: anyEstimated,
    counts,
    savings: {
      dollars: round2(savedDollars),
      tokens: savedTokens,
      caughtStalls: counts.saved,
    },
    agents: Array.from(perAgent.values()).map((a) => ({ ...a, dollars: round2(a.dollars) })),
    label: typeof opts.label === 'string' ? opts.label : null,
  };
  receipt.headline = headline(receipt);
  return receipt;
}

// The tweetable one-liner. Deliberately compact and honest.
function headline(receipt) {
  const landed = receipt.counts.landed;
  const total = receipt.runCount;
  const parts = [];
  parts.push(`${total} agent${total === 1 ? '' : 's'}`);
  const money = receipt.tokensEstimated ? `~$${receipt.totalDollars.toFixed(2)}` : `$${receipt.totalDollars.toFixed(2)}`;
  parts.push(money);
  if (landed) parts.push(`${landed} landed`);
  if (receipt.savings.caughtStalls > 0) {
    const s$ = receipt.savings.dollars;
    parts.push(s$ > 0
      ? `${receipt.savings.caughtStalls} runaway${receipt.savings.caughtStalls === 1 ? '' : 's'} caught (up to $${s$.toFixed(2)} saved)`
      : `${receipt.savings.caughtStalls} runaway${receipt.savings.caughtStalls === 1 ? '' : 's'} caught`);
  }
  return parts.join(' | ');
}

function num(v) { return Number.isFinite(v) ? v : 0; }
function round2(v) { return Math.round((Number.isFinite(v) ? v : 0) * 100) / 100; }

module.exports = {
  fromSummary,
  classify,
  estimateSavings,
  buildFleetReceipt,
};
