'use strict';

// Aggregates local workflow run history into the receipt figures published in
// .husk.json artifacts. Keep this deterministic: no fs, no clock, no Electron,
// no Date.parse/local timezone behavior.
//
// Invariants: figures carry sample sizes; unknown quantities are null, not
// zero; unreadable rows are skipped without quoting their errors; dollars are
// omitted because readers price token counts locally.

// v1 can only claim process exits, not semantic correctness.
const OUTCOME_BASIS = 'process-exit';

// Keep aligned with the run-history trim cap in main.js.
const DEFAULT_HISTORY_MAX = 200;

// A timed-out step truncates the duration distribution at this value.
const DEFAULT_STEP_TIMEOUT_MS = 300000;

// How many source rows one walk reads, counted here rather than by the list.
const MAX_SOURCE_RUNS = 10000;

// How many step positions one run's walk reads.
const MAX_RUN_STEPS = 4096;

// Wire-schema cap; intentionally separate from the source-walk budget.
const MAX_RECEIPT_RUNS = 10000;

// Overflows are flagged instead of clamped.
const MAX_RECEIPT_DURATION_MS = 3600000;

// Compared for identity only; the canonicalizer owns the fingerprint grammar.
const GRAPH_HASH_RE = /^[A-Za-z0-9._:-]{1,200}$/;

// Exact wire shape emitted by toISOString().
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Accepted timestamp input: RFC 3339-ish date-time only, parsed without the
// host timezone database.
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, every quantifier bounded, and isoStamp caps input at 64 chars before exec; safe-regex flags any nested group
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))?$/;

// Re-check after offset application so year-1000 input cannot format as 0999.
const MIN_STAMP_MS = Date.UTC(1000, 0, 1);

// ─── small pure helpers ──────────────────────────────────────────────────────

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Publishable finite non-negative integer; normalizes -0 at the shared gate.
function safeCount(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0 || v > Number.MAX_SAFE_INTEGER) return null;
  const n = Math.floor(v);
  return n === 0 ? 0 : n;
}

// Days in a Gregorian month, so a hand-edited "2026-02-30" is refused instead
// of rolling forward into March the way the Date constructor would.
function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

// Exact median; callers round once at the edge.
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return null;
  const mid = n >> 1;
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Normalize a row timestamp into published ISO form plus epoch ms, without
// Date.parse or host-local timezone behavior.
function isoStamp(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  const m = ISO_DATETIME_RE.exec(value);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  // Fractions are truncated to milliseconds rather than rounded, so a stamp
  // never moves past the instant the row recorded.
  const millis = m[7] === undefined ? 0 : Number(`${m[7]}000`.slice(0, 3));

  // Date.UTC maps 0..99 onto 1900..1999.
  if (year < 1000) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMs = 0;
  if (m[8] !== undefined) {
    const offsetHours = Number(m[9]);
    const offsetMinutes = Number(m[10]);
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    const magnitude = (offsetHours * 60 + offsetMinutes) * 60000;
    offsetMs = m[8] === '-' ? -magnitude : magnitude;
  }

  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMs;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  // Re-refuse after offset application.
  if (ms < MIN_STAMP_MS) return null;
  let text;
  try {
    text = new Date(ms).toISOString();
  } catch (_) {
    return null;
  }
  if (!ISO_MS_RE.test(text)) return null;
  return { ms, text };
}

// ─── per-run readings ────────────────────────────────────────────────────────

// How long the run took, in milliseconds. main.js records `ms` directly
// (main.js:5343); the timestamps are the fallback for a row that carries no
// usable `ms` field. A run whose duration cannot be established either way is
// not guessed at: it still counts in the outcome tally, it just does not vote
// on the median, and medianDurationN says how many runs actually did.
function runDurationMs(row) {
  const direct = safeCount(row.ms);
  if (direct !== null) return direct;
  const started = isoStamp(row.startedAt);
  const finished = isoStamp(row.finishedAt);
  if (!started || !finished) return null;
  const span = finished.ms - started.ms;
  if (!Number.isFinite(span) || span < 0) return null;
  return Math.floor(span);
}

// Read one usage record into the four fields the receipt publishes. Both key
// spellings are accepted: main.js normalizes the stream-json usage to camelCase
// on the autopilot path (main.js:2195-2199) and that is the contract for a run
// row, while the underlying event carries snake_case.
//
// A record with a field present but unusable is rejected whole rather than
// partially trusted, so the run drops out of the token sample.
function readUsage(u) {
  if (!isObject(u)) return null;
  // A JSON null is an absence, the same as a missing key, so it falls through
  // to the other spelling rather than standing in front of it: a writer that
  // always emits the camelCase shape and copies the event across produces
  // `input: null` beside a real `input_tokens: 500`.
  //
  // Zero falls through too, and only to a sibling that carries a real count. A
  // zeroed camelCase accumulator persisted beside the raw event is the shape
  // `ms` already has here (main.js:5343 writes `st.ms || 0`), and totalOrNull
  // reads four zeros as no report at all. A zero with no counted sibling still
  // reads as the zero it is.
  //
  // Each spelling is read once into a local, so the value tested is the value
  // assigned.
  const pick = (a, b) => {
    const first = u[a];
    if (first === undefined || first === null) return u[b];
    if (first === 0) {
      const second = u[b];
      const n = (second === undefined || second === null) ? null : safeCount(second);
      if (n !== null && n !== 0) return second;
    }
    return first;
  };
  const raw = {
    input: pick('input', 'input_tokens'),
    output: pick('output', 'output_tokens'),
    cacheRead: pick('cacheRead', 'cache_read_input_tokens'),
    cacheCreate: pick('cacheCreate', 'cache_creation_input_tokens'),
  };
  const out = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let sawAny = false;
  for (const key of Object.keys(out)) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    const n = safeCount(v);
    if (n === null) return null;
    out[key] = n;
    sawAny = true;
  }
  return sawAny ? out : null;
}

// The run's token usage, or null when the run did not report any.
//
// Null is the answer for every vendor Husk does not run with
// --output-format stream-json, since that is the output it can read usage from
// (main.js:5696). Reporting zeros for the others would publish a measurement
// nobody took, which is why a record whose four fields are all zero counts as
// no report at all.
function runTokens(row) {
  // The run-level total wins only when it says something. Four zeros are no
  // report at all, so a zeroed accumulator persisted alongside real per-step
  // usage falls through to the steps rather than beating them.
  //
  // A tokens field that is present and unreadable is a different fact from no
  // tokens field, and only the second falls through. readUsage rejects a record
  // whole rather than trusting half of it, so a run total in a refused shape
  // takes the whole run out of the token sample rather than being replaced by
  // whatever its steps add up to.
  const hasDirect = isObject(row.tokens);
  const direct = hasDirect ? readUsage(row.tokens) : null;
  if (hasDirect && !direct) return null;
  const directTotal = direct ? totalOrNull(direct) : null;
  if (directTotal) return directTotal;

  const steps = Array.isArray(row.steps) ? row.steps : [];
  const n = stepCount(steps);
  const sum = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let sawAny = false;
  // Indexed over a count read once, matching isCensored and the outer walk.
  for (let i = 0; i < n; i += 1) {
    const step = steps[i];
    if (!isObject(step)) continue;
    const u = readUsage(step.usage);
    if (!u) continue;
    sawAny = true;
    for (const key of Object.keys(sum)) {
      sum[key] += u[key];
      if (sum[key] > Number.MAX_SAFE_INTEGER) return null;
    }
  }
  return sawAny ? totalOrNull(sum) : null;
}

function totalOrNull(u) {
  return (u.input || u.output || u.cacheRead || u.cacheCreate) ? u : null;
}

// Whether any step in this run was killed by the per-step timer. The
// authoritative signal is the flag main.js writes; the duration heuristic
// below speaks only for a row that carries no such flag, and it is
// deliberately strict (a failed step at or past the full timeout) so a step
// that failed on its own at 299 seconds is not miscounted as censored.
function isCensored(row, stepTimeoutMs) {
  if (row.timedOut === true) return true;
  const steps = Array.isArray(row.steps) ? row.steps : [];
  // Indexed, over a count read once, for the reason MAX_RUN_STEPS states. Each
  // walk takes its own count so both are bounded by what they measured.
  const n = stepCount(steps);
  for (let i = 0; i < n; i += 1) {
    const step = steps[i];
    if (!isObject(step)) continue;
    if (step.timedOut === true) return true;
    const ms = safeCount(step.ms);
    if (step.status === 'failed' && ms !== null && ms >= stepTimeoutMs) return true;
  }
  return false;
}

// How many step positions a walk may read, or null when the list declares more
// than the budget allows. Null refuses the whole row rather than clamping, so a
// total is never taken over a prefix and published as complete.
function stepCount(steps) {
  let n;
  try {
    n = safeCount(steps.length);
  } catch (_) {
    return null;
  }
  if (n === null) return null;
  return n > MAX_RUN_STEPS ? null : n;
}

// Which of the four outcome buckets a finished run lands in, or null when the
// run is not finished and has no place in a receipt at all.
//
// Precedence is stopped, then timedOut, then failed. A run the user cancelled
// is described by that fact first, since the workflow was never given the
// chance to fail. A run with a killed step reads as timedOut rather than
// failed, because the kill is what produced the non-zero exit and it is what
// the duration figure beside it needs to be read against.
function outcomeBucket(status, censored) {
  const s = typeof status === 'string' ? status : '';
  if (s === 'stopped' || s === 'cancelled') return 'stopped';
  if (censored) return 'timedOut';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'done' || s === 'completed') return 'completed';
  return null;
}

// Which sentence the duration figure is allowed to appear in. The copy rule is
// binding across the feature: a median from two runs is a range and a median
// from one run is that run, so the label ships with the number instead of
// being re-derived by every surface that draws it.
function precisionFor(n) {
  if (n <= 0) return 'none';
  if (n === 1) return 'single';
  if (n === 2) return 'range';
  return 'median';
}

// ─── the aggregation ─────────────────────────────────────────────────────────

// A caller-supplied limit, or the documented default when the caller did not
// state one, or null when they stated something we cannot use.
//
// An unusable value is refused by name rather than defaulted, and zero is a
// value rather than an absence: a stepTimeoutMs of 0 says "treat any failed
// step as censored", and a historyMax of 0 says "this list was already
// trimmed".
function readLimit(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return safeCount(value);
}

// How many rows the source list declares it has, measured once, before a single
// row has been read out of it. A length that is not a usable count reads as
// empty, which produces an honest aggregate of nothing.
//
// Taking the measurement once is the point. Everything downstream is stated
// against this single number: the walk's stopping point, the unread bucket, and
// the sourceRuns the caller reconciles them against.
function sourceLength(runs) {
  try {
    const n = safeCount(runs.length);
    return n === null ? 0 : n;
  } catch (_) {
    return 0;
  }
}

// Read one row down to the handful of values the tally needs, or name the
// bucket that excludes it.
//
// Every property access on a row lives in this one function, so the loop below
// wraps a single call. It commits nothing: the counters are touched only after
// this has returned, so `runs` and the outcome tally always agree exactly, as
// the wire format requires.
function readRow(row, workflowId, graphHash, stepTimeoutMs) {
  if (!isObject(row)) return { excluded: 'malformed' };
  // A row carrying no id at all is a truncated record, and it belongs to no
  // workflow's history.
  if (typeof row.workflowId !== 'string' || !row.workflowId) return { excluded: 'malformed' };
  if (row.workflowId !== workflowId) return { excluded: 'otherWorkflow' };
  // A row with no fingerprint at all is history recorded without one, which is
  // a different fact from a row that names a different graph. Counting the two
  // apart lets a surface say "9 earlier runs predate this" rather than implying
  // the author edited the workflow.
  if (typeof row.graphHash !== 'string' || !row.graphHash) return { excluded: 'unhashed' };
  if (row.graphHash !== graphHash) return { excluded: 'otherGraph' };

  // A row whose step list is longer than any walk will read contributes no
  // duration and no token figure, since both would be taken over a prefix and
  // published as totals. The gate sits here, before either walk.
  if (Array.isArray(row.steps) && stepCount(row.steps) === null) return { excluded: 'malformed' };

  const censored = isCensored(row, stepTimeoutMs);
  const bucket = outcomeBucket(row.status, censored);
  // A run still in flight has no duration and no outcome, so it has no place
  // in a receipt at all.
  if (!bucket) return { excluded: 'unfinished' };

  return {
    excluded: null,
    bucket,
    censored,
    ms: runDurationMs(row),
    tokens: runTokens(row),
    started: isoStamp(row.startedAt),
  };
}

// aggregateRuns(runs, opts) reduces a run history to one receipt's worth of
// figures.
//
// opts:
//   workflowId       required. The local workflow whose runs these are.
//   graphHash        required. Runs are filtered by BOTH, because a receipt
//                    from an edited graph is a receipt for a different
//                    program: the steps a reader is about to install are not
//                    the steps those runs executed.
//   historyMax       how long the source list is allowed to be before it is
//                    assumed to have been trimmed. Defaults to main.js's 200.
//                    Stated and unusable is refused, not defaulted.
//   sourceTruncated  set by a caller that trimmed the list itself, so the
//                    windowed flag survives a pre-filter.
//   stepTimeoutMs    the per-step kill, for the censoring heuristic. Same
//                    refusal rule, and 0 is a value rather than an absence.
//
// Returns { ok: true, aggregate } or { ok: false, error }. Zero matching runs
// is a successful aggregation of nothing, not an error: "no receipts yet" is a
// state the card renders.
//
// Whether the result can go on the wire is answered by `publishable` and, when
// it cannot, by the field names in `publishBlockers`. Runs of 0, runs past the
// schema's ceiling, a window nothing datable was found for, a duration nothing
// timed, and a median longer than the schema's hour are five reasons and each
// one says its own name.
function aggregateRuns(runs, opts) {
  // The whole computation sits under one guard, so this function returns a
  // refusal rather than throwing. The per-row reads are contained individually
  // below; this catches what is left, which is mostly opts itself. The
  // exception is not quoted back: its message came from the same input being
  // refused, and a surface would render it.
  try {
    return computeAggregate(runs, opts);
  } catch (_) {
    return { ok: false, error: 'runs could not be aggregated: an input raised while it was being read' };
  }
}

function computeAggregate(runs, opts) {
  if (!isObject(opts)) {
    return { ok: false, error: 'opts must be an object with workflowId and graphHash' };
  }
  const workflowId = typeof opts.workflowId === 'string' ? opts.workflowId : '';
  if (!workflowId || workflowId.length > 256) {
    return { ok: false, error: 'workflowId must be a string of 1..256 characters' };
  }
  const graphHash = typeof opts.graphHash === 'string' ? opts.graphHash : '';
  if (!GRAPH_HASH_RE.test(graphHash)) {
    return { ok: false, error: 'graphHash must be a printable token of 1..200 characters' };
  }
  if (!Array.isArray(runs)) {
    return { ok: false, error: 'runs must be an array' };
  }
  const historyMax = readLimit(opts.historyMax, DEFAULT_HISTORY_MAX);
  if (historyMax === null) {
    return { ok: false, error: 'historyMax must be a non-negative integer below 2^53, or absent for the default' };
  }
  const stepTimeoutMs = readLimit(opts.stepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS);
  if (stepTimeoutMs === null) {
    return { ok: false, error: 'stepTimeoutMs must be a non-negative integer below 2^53, or absent for the default' };
  }
  const sourceTruncated = opts.sourceTruncated === true;

  // The list arrives newest first, so an over-long history is cut from the
  // tail and the runs closest to the graph as it stands today are kept. The cut
  // is made by where this loop stops counting rather than by asking the list
  // for a shorter copy of itself.
  const sourceRuns = sourceLength(runs);
  const walked = sourceRuns > MAX_SOURCE_RUNS ? MAX_SOURCE_RUNS : sourceRuns;

  const outcomes = { completed: 0, failed: 0, stopped: 0, timedOut: 0 };
  // `unread` holds the rows past the hard cap, which were never looked at.
  // sourceRuns and excluded are published side by side as "what was looked at
  // and what was set aside", so this bucket is what keeps that subtraction
  // closing when the cap fires.
  //
  // Both ends of it come from the one length reading, so the bucket is a
  // difference between a number and a clamp of itself and is never negative.
  const excluded = {
    otherWorkflow: 0,
    otherGraph: 0,
    unhashed: 0,
    unfinished: 0,
    malformed: 0,
    unread: sourceRuns - walked,
  };
  const durations = [];
  const tokenRows = [];
  let durationCensored = 0;
  let matched = 0;
  let first = null;
  let last = null;

  // Indexed rather than for-of, and over a count fixed before the first read,
  // so the walk visits exactly the positions that were measured. Every position
  // read is accounted for below whether or not anything was there, so the
  // ledger closes either way.
  //
  // The subscript itself sits inside the guard along with the read, so a row
  // that raises costs itself its place in the tally and nothing else.
  for (let i = 0; i < walked; i += 1) {
    let read;
    try {
      read = readRow(runs[i], workflowId, graphHash, stepTimeoutMs);
    } catch (_) {
      // A row that raises on being read is malformed in the only sense this
      // module cares about: nothing could be learned from it. It is counted
      // with the nulls and the strings, and the other rows still aggregate.
      read = { excluded: 'malformed' };
    }
    if (read.excluded) { excluded[read.excluded] += 1; continue; }

    matched += 1;
    outcomes[read.bucket] += 1;
    if (read.censored) durationCensored += 1;

    // Censored and cancelled runs stay in the duration sample, so the
    // denominator behind the median stays the count `runs` reports. The
    // disclosure fields let a reader discount the figure themselves.
    if (read.ms !== null) durations.push(read.ms);
    if (read.tokens) tokenRows.push(read.tokens);
    if (read.started) {
      if (!first || read.started.ms < first.ms) first = read.started;
      if (!last || read.started.ms > last.ms) last = read.started;
    }
  }

  const medianDuration = median(durations);
  const medianDurationMs = medianDuration === null ? null : Math.round(medianDuration);
  // Each token field is its own median over the runs that reported usage, so
  // the four together describe a typical run field by field rather than any
  // single run that happened. A reader adding them up gets a plausible total
  // and not an invoice, which is the same caveat that applies to the dollar
  // estimate computed from them downstream.
  //
  // The four medians go through the same all-zero test a single run's usage
  // does, because independent medians can each land on zero over runs that all
  // reported real usage: three runs reporting one nonzero tier each produce
  // four zero medians, and published as zeros they read as "this workflow moves
  // no tokens". medianTokensN keeps the honest count either way, so null with a
  // count above zero is distinguishable from nobody reporting.
  const medianTokens = tokenRows.length ? totalOrNull({
    input: Math.round(median(tokenRows.map((t) => t.input))),
    output: Math.round(median(tokenRows.map((t) => t.output))),
    cacheRead: Math.round(median(tokenRows.map((t) => t.cacheRead))),
    cacheCreate: Math.round(median(tokenRows.map((t) => t.cacheCreate))),
  }) : null;

  // Named runWindow rather than window so that nothing here depends on which
  // realm the module was loaded into; the published field keeps the short name.
  const runWindow = first && last ? { firstRunAt: first.text, lastRunAt: last.text } : null;
  const medianDurationExceedsMax = medianDurationMs !== null && medianDurationMs > MAX_RECEIPT_DURATION_MS;

  // The wire receipt requires runs >= 1 and marks neither window nor
  // medianDurationMs nullable, so an aggregate carrying a null in either is
  // not publishable however many runs it counted. Each blocker is the name of
  // the field that blocks it, so a caller can both refuse and say why.
  const publishBlockers = [];
  if (matched < 1) publishBlockers.push('runs');
  // The schema's range on `runs` has two ends and this checks both, so the wire
  // limit is asserted where publishability is decided rather than inherited
  // from how far the walk above happened to get.
  if (matched > MAX_RECEIPT_RUNS) publishBlockers.push('runsExceedsMax');
  if (runWindow === null) publishBlockers.push('window');
  if (medianDurationMs === null) publishBlockers.push('medianDurationMs');
  if (medianDurationExceedsMax) publishBlockers.push('medianDurationExceedsMax');

  const aggregate = {
    workflowId,
    graphHash,
    runs: matched,
    // True when the history read from had already been trimmed, so the window
    // below describes what survived rather than everything that ran. At exactly
    // historyMax the two cases are indistinguishable and this takes the
    // conservative one.
    runsWindowed: sourceTruncated
      || sourceRuns >= historyMax
      || sourceRuns > MAX_SOURCE_RUNS,
    // Both ends are run STARTS. Mixing a start with a finish would make the
    // window's width mean two different things at its two edges.
    window: runWindow,
    outcomes,
    outcomeBasis: OUTCOME_BASIS,
    medianDurationMs,
    medianDurationN: durations.length,
    // The wire schema caps the median at an hour; the caller needs to know
    // when the honest value will not fit rather than discovering it as a
    // schema failure or, worse, clamping it.
    medianDurationExceedsMax,
    // Not published, and not a distribution: two runs are a range by the copy
    // rule, and a range needs its two ends. Reduced rather than spread into
    // Math.min/Math.max, so the length of the list does not decide whether the
    // call is legal.
    durationRangeMs: durations.length
      ? {
        min: durations.reduce((a, b) => (b < a ? b : a), durations[0]),
        max: durations.reduce((a, b) => (b > a ? b : a), durations[0]),
      }
      : null,
    durationCensored,
    medianTokens,
    medianTokensN: tokenRows.length,
    precision: precisionFor(durations.length),
    // Whether this record can go on the wire as it stands, and the names of
    // the fields that stop it if not. A caller that publishes only when this
    // is true never hands the schema a null it does not accept.
    publishable: publishBlockers.length === 0,
    publishBlockers,
    // What was looked at and what was set aside, so a surface can explain a
    // thin receipt. runs plus the excluded buckets equals sourceRuns exactly.
    sourceRuns,
    excluded,
  };
  return { ok: true, aggregate };
}

// ─── figures from a shipped log ──────────────────────────────────────────────

// The workflow id the reconstructed rows are keyed on.
//
// A published log carries no workflow id: the author's local `wf-1762...` says
// nothing to a reader, and the binding row already names the identity that
// matters, the fingerprint of the graph that ran. aggregateRuns filters on
// both, so the reconstruction gives every row this same literal and hands the
// same one back in.
const CHAIN_WORKFLOW_ID = 'husk.chain';

// figuresFromChain(sessions) recomputes a receipt's figures from the audit rows
// shipped inside the file.
//
// `sessions` is verifyArtifactChain's output: one entry per session, each with
// the parsed rows of one run in order. The publisher builds the declared
// figures with this function and the reader recomputes them with the same one,
// so a disagreement means the file and its log disagree rather than two
// implementations of a median drifting apart. That is also why the
// reconstruction goes back through aggregateRuns rather than adding up rows
// directly: there is one definition of a censored run, an outcome bucket and a
// token total in this codebase, and it is above.
//
// Three figures are not derived here. `runsWindowed` is a fact about the
// author's run history, which a log cannot see. `environment` is what their
// machine was, which no row carries. The run window is derived, since the rows
// carry the timestamps, but it stays in the author-states tier wherever it is
// rendered, because a clock is as author-stated as the rest of the file.
//
// Returns { ok: true, figures, aggregate } or { ok: false, error }.
function figuresFromChain(sessions) {
  try {
    return chainFigures(sessions);
  } catch (_) {
    return { ok: false, error: 'the shipped log raised while its figures were being recomputed' };
  }
}

function chainFigures(sessions) {
  if (!Array.isArray(sessions) || sessions.length < 1) {
    return { ok: false, error: 'the shipped log names no sessions' };
  }
  let graphHash = null;
  const rows = [];
  for (let i = 0; i < sessions.length; i += 1) {
    const built = runFromSession(sessions[i]);
    if (!built.ok) return built;
    // Every session was already checked against the others by the chain walk;
    // this is the same rule stated where the arithmetic happens, so one figure
    // always describes one program.
    if (graphHash !== null && built.row.graphHash !== graphHash) {
      return { ok: false, error: 'the sessions in this log were run against different workflows' };
    }
    graphHash = built.row.graphHash;
    rows.push(built.row);
  }

  const agg = aggregateRuns(rows, {
    workflowId: CHAIN_WORKFLOW_ID,
    graphHash,
    // A log is the whole of what was shipped rather than a window onto a longer
    // history, so stating the cap above the count keeps runsWindowed false.
    historyMax: rows.length + 1,
    stepTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  });
  if (!agg.ok) return { ok: false, error: agg.error };
  const a = agg.aggregate;
  return {
    ok: true,
    aggregate: a,
    figures: {
      graphHash,
      sessions: rows.length,
      runs: a.runs,
      window: a.window,
      outcomes: a.outcomes,
      outcomeBasis: a.outcomeBasis,
      medianDurationMs: a.medianDurationMs,
      durationCensored: a.durationCensored,
      medianTokens: a.medianTokens,
      publishable: a.publishable,
      publishBlockers: a.publishBlockers,
    },
  };
}

// One session's rows back into the run-history shape aggregateRuns reads.
//
// The rows were parsed by the chain walk, so they are plain JSON and are read
// directly. A payload field that is missing or the wrong type contributes
// nothing, and the aggregation upstream treats an unreadable duration as a run
// that does not vote on the median rather than as a run that took no time.
function runFromSession(session) {
  if (!isObject(session)) return { ok: false, error: 'a session in this log is not readable' };
  const rows = Array.isArray(session.rows) ? session.rows : null;
  if (!rows || rows.length < 4) return { ok: false, error: 'a session in this log is too short to describe a run' };
  const binding = payloadOf(rows[1]);
  const graphHash = binding && typeof binding.graphHash === 'string' ? binding.graphHash : null;
  if (!graphHash) return { ok: false, error: 'a session in this log does not name the workflow it ran' };

  const start = payloadOf(rows[0]) || {};
  const summary = payloadOf(rows[rows.length - 1]) || {};
  const steps = [];
  for (let i = 2; i < rows.length - 1; i += 1) {
    const row = rows[i];
    if (!isObject(row) || row.kind !== 'step_end') continue;
    const p = payloadOf(row) || {};
    steps.push({
      status: typeof p.status === 'string' ? p.status : '',
      ms: p.ms,
      timedOut: p.timedOut === true,
      usage: isObject(p.usage) ? p.usage : null,
    });
  }

  return {
    ok: true,
    row: {
      id: typeof session.sessionId === 'string' ? session.sessionId : '',
      workflowId: CHAIN_WORKFLOW_ID,
      graphHash,
      status: typeof summary.status === 'string' ? summary.status : '',
      // The run's own two ends, from the row that recorded them. runDurationMs
      // prefers `ms` and falls back to the pair, which is the same order it
      // applies to a local history row.
      startedAt: typeof summary.startedAt === 'string' ? summary.startedAt
        : (typeof start.startedAt === 'string' ? start.startedAt : ''),
      finishedAt: typeof summary.finishedAt === 'string' ? summary.finishedAt : '',
      ms: summary.ms,
      steps,
    },
  };
}

function payloadOf(row) {
  return isObject(row) && isObject(row.payload) ? row.payload : null;
}

// The fields whose recomputation decides whether a receipt keeps its figures.
//
// These five and no others. The window and `runsWindowed` stay out because they
// are permanently author-stated, and comparing an author's timestamps against
// the same author's timestamps states a tautology. `environment` stays out for
// the same reason: no row carries the machine it was written on.
const COMPARED_FIELDS = ['runs', 'outcomes', 'medianDurationMs', 'durationCensored', 'medianTokens'];

// compareFigures(receipt, figures) answers whether a receipt says what its own
// log says. Disagreement is not a caveat rendered beside the numbers: the
// caller collapses the whole receipt block.
function compareFigures(receipt, figures) {
  const differences = [];
  if (!isObject(receipt) || !isObject(figures)) {
    return { agrees: false, differences: [{ field: 'receipt', declared: 'unreadable', derived: 'unreadable' }] };
  }
  for (const field of COMPARED_FIELDS) {
    const declared = receipt[field];
    const derived = figures[field];
    if (!sameFigure(declared, derived)) {
      differences.push({ field, declared: describeFigure(declared), derived: describeFigure(derived) });
    }
  }
  return { agrees: differences.length === 0, differences };
}

// Equality for the shapes a compared field can take: a whole number, a null, or
// a flat record of whole numbers. Written out rather than done by serializing
// both sides, so key order does not decide the answer.
function sameFigure(a, b) {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(b);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  for (const key of Object.keys(a)) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
  }
  return true;
}

// A compared value as one short line for the refusal pane. Records are printed
// field by field in a fixed order so the two sides of a difference line up
// under each other and the eye can find the one number that moved.
function describeFigure(v) {
  if (v === null || v === undefined) return 'nothing';
  if (typeof v === 'number') return String(v);
  if (!isObject(v)) return 'unreadable';
  return Object.keys(v).sort().map((k) => `${k} ${v[k]}`).join(', ');
}

module.exports = {
  OUTCOME_BASIS,
  CHAIN_WORKFLOW_ID,
  COMPARED_FIELDS,
  figuresFromChain,
  compareFigures,
  DEFAULT_HISTORY_MAX,
  DEFAULT_STEP_TIMEOUT_MS,
  MAX_SOURCE_RUNS,
  MAX_RECEIPT_RUNS,
  MAX_RECEIPT_DURATION_MS,
  aggregateRuns,
  // exported for unit tests; not part of the public API.
  _internal: {
    median, isoStamp, safeCount, readUsage, runTokens, runDurationMs, isCensored, outcomeBucket, precisionFor,
    runFromSession, sameFigure, describeFigure,
  },
};
