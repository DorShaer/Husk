'use strict';

// Receipt aggregation for portable workflows.
//
// A receipt is what a published .husk.json says about runs that already
// happened: how many there were, how they ended, how long the typical one
// took, and how many tokens it moved. This module turns the local run history
// (the newest-first list main.js keeps in workflow-runs.json) into that
// summary and does nothing else. It does not read the file, does not mint a
// receipt id, does not know the wire shape: the caller supplies the rows, and
// the artifact builder projects the fields it needs onto the published
// receipt. Keeping the arithmetic in a module with no fs, no clock and no
// Electron is what makes 31 runs a fixture rather than an afternoon. The one
// host facility it touches is calendar arithmetic (Date.UTC going in,
// toISOString coming out) and never Date.now, never Date.parse and never the
// local zone, so one history aggregates to the same figures on every machine
// that opens the file.
//
// Three rules run through the whole file.
//
// Every figure carries its own sample size. A median over one run is a
// stopwatch reading and a median over thirty-one is a claim about a program,
// and the only way a surface can tell those apart is if the number arrives
// with the count attached. So medianDurationMs travels with medianDurationN,
// medianTokens with medianTokensN, and `precision` names which of the three
// sentences the reader is allowed to write ("that run", "range", "median").
// A UI that wants to imply authority from a sample of one has to work at it.
//
// A quantity that cannot be honestly computed is null, never zero. Zero is a
// measurement, and a workflow that reported nothing did not measure zero. The
// rule is enforced twice, once per run and once on the aggregate, because four
// independent medians can each land on zero over runs that all reported real
// usage, and a row of zeros is the same false claim however it was arrived at.
//
// Nothing here throws. The rows come from a JSON file on the author's disk
// that nothing stops them from hand-editing, and a row that fights back on
// being read (an accessor that raises, a proxy that traps every get) costs
// itself its place in the tally and nothing else. Reads that can raise are
// contained one row at a time, the call as a whole has a backstop under it,
// and the refusal string never quotes the exception, since that text came from
// the same input we are refusing.
//
// There is deliberately no dollar figure here and no seam where one could be
// added. src/lib/autonomy/budget.js prices copilot, codex, aider and gemini at
// { in: 0, out: 0 } (budget.js:58-61) because Husk cannot see which account is
// paying, so a workflow that costs its author four dollars a run would
// aggregate to free with two decimal places. That rate table is also a frozen
// literal per build whose own comment (budget.js:36-37) says the meter is for
// stopping a runaway rather than for billing accuracy, so two Husk versions
// produce different dollars from identical tokens. Tokens are the only
// quantity that survives the trip to a stranger's machine. The reading machine
// multiplies them by its own rates and labels the result its own estimate.

// The only outcome basis v1 can emit. A step's status is its process exit code
// and nothing else (main.js:5750), so an agent that answers confidently wrong
// and exits 0 is recorded as done. The basis travels with the counts so no
// surface can render them under the word "pass".
const OUTCOME_BASIS = 'process-exit';

// WF_RUNS_MAX in main.js:5287. History is trimmed to this length on every
// write, so a source list that is already this long is one whose oldest runs
// may have been discarded, and the receipt has to say so.
const DEFAULT_HISTORY_MAX = 200;

// WF_STEP_TIMEOUT_MS in main.js:5658. A step killed by that timer is recorded
// at (or a hair over) this duration, which truncates the run's duration
// distribution from the top.
const DEFAULT_STEP_TIMEOUT_MS = 300000;

// Hard bound on how much history we will walk in one call. The real list is
// capped at 200 by main.js, so this only fires for a corrupted or hand-edited
// file; we take the newest rows and flag the result as windowed rather than
// refusing, because a caller with too much history still deserves an answer.
//
// The bound is spent by the walk itself, as a counter this module owns, and is
// never requested from the container. Asking the input to cut itself down
// (runs.slice(0, MAX_SOURCE_RUNS)) makes the one limit in the function a value
// the list gets to choose, since `slice` is a property of the list and a list
// that defines its own returns whatever length it likes. The walk then runs
// past the wire schema's ceiling and publishes a run count no reader accepts.
const MAX_SOURCE_RUNS = 10000;

// The same ceiling, one level down. The outer walk over runs is an indexed loop
// over a count fixed before the first read, because a for-of hands its stopping
// condition to the list it is walking, and the two inner walks over row.steps
// are indexed for the identical reason: a step whose own accessor appends to
// the array keeps it one element ahead of the iterator forever, and a proxied
// length can claim 2^53-1 positions without allocating a byte. Neither throws,
// so no try/catch reaches them, and the thread they never return to is the
// Electron main one.
//
// A real run has a step per workflow node, and the graph itself is capped at 64
// nodes by sanitizeNode. 4096 is three orders of magnitude above anything the
// product can produce and still small enough that the walk is over in
// microseconds, so a row that passes it is not a big run, it is a value no run
// of this product produced.
const MAX_RUN_STEPS = 4096;

// The largest `runs` the published receipt schema accepts (spec, receipts:
// "runs integer 1..10000"). It is the same number as MAX_SOURCE_RUNS today and
// deliberately not the same constant: one is a budget for how much history we
// are willing to read, the other is a limit on what the wire format will carry,
// and the day either moves the other should not follow it silently. Stated here
// so publishability is decided against the schema rather than inferred from
// wherever the walk happened to stop.
const MAX_RECEIPT_RUNS = 10000;

// The published receipt schema caps medianDurationMs at one hour. A workflow
// of a dozen five-minute steps can genuinely exceed that, and quietly clamping
// a 70 minute median to 60 would be the same lie durationCensored exists to
// name, so the overflow is reported as a flag and the honest value is kept.
const MAX_RECEIPT_DURATION_MS = 3600000;

// A graph fingerprint is compared for identity and never parsed here. The
// prefix ("husk-wfg-1:") belongs to the canonicalizer, and duplicating its
// grammar in this module would give the next rule set two places to be
// updated. All we require is that it is a plausible, bounded, printable token.
const GRAPH_HASH_RE = /^[A-Za-z0-9._:-]{1,200}$/;

// The exact shape the wire format wants for a timestamp, which is also what
// new Date().toISOString() produces. Anything a row carries is re-emitted
// through this, so a 40 character string or a year 275760 date sitting in a
// hand-edited history never reaches a published window.
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// What we are willing to read a timestamp out of. Date.parse is not usable
// here: it is the one call in this module that would reach the host timezone
// database, and a string with no offset is defined to mean local time, so one
// history would publish a different window on every machine that opened it.
// It also accepts whatever else the engine feels like ("Feb 6 2026", "2026"),
// which turns a vague string into a precise instant without saying so. This
// grammar is the calendar half of RFC 3339 and nothing more: a full date, a
// time to at least the minute, an optional fraction, an optional offset.
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))?$/;

// The earliest instant a stamp is allowed to land on, as an epoch offset. The
// year written in the string is guarded separately and for a different reason
// (Date.UTC folds 0..99 into the twentieth century, so the digits have to be
// checked before they reach it); this is the guard on the instant that comes
// out the other side. An offset of up to 23:59 moves a stamp most of a day, so
// a year the written-year check refused can be reached from the year above it
// by carrying an offset, and 1000-01-01T00:00:00+23:59 formats back as a
// perfectly wire-shaped "0999-12-31T00:01:00.000Z". Both ends need saying, and
// the upper end says itself: toISOString renders anything past year 9999 with
// an expanded "+275760" style year, which ISO_MS_RE already refuses.
const MIN_STAMP_MS = Date.UTC(1000, 0, 1);

// ─── small pure helpers ──────────────────────────────────────────────────────

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// A count we are willing to publish: finite, non-negative, and inside the
// range where integer arithmetic is exact. Anything else (NaN, Infinity, -1,
// 1e308, "12", null) is not a number we can defend, so callers treat its
// presence as a reason to discard the whole record it came from rather than to
// substitute a zero.
//
// Negative zero passes the range test (-0 < 0 is false) and survives both
// Math.floor and Math.round, so it is flattened here rather than at each of
// the half dozen figures it would otherwise reach. The canonicalisation rules
// require it gone before serialisation, and while JSON.stringify happens to
// erase it on the way out, a caller comparing the aggregate with Object.is
// before it serialises would see a value the wire format says cannot exist.
// This is the single gate every number in the module passes through, so it is
// the one place the normalisation belongs.
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

// The median of a non-empty list of finite numbers. Even counts take the mean
// of the two middle values, which is the textbook definition and the one that
// does not bias the answer: taking the lower middle instead would pull every
// even-sized sample down, and a duration figure that leans low is the exact
// failure mode durationCensored exists to disclose. The caller rounds; this
// returns the exact value so a rounding decision is made once, at the edge.
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return null;
  const mid = n >> 1;
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Normalize whatever a row carries as a timestamp into the exact ISO form the
// receipt window publishes, or null. Returns the parsed epoch alongside it so
// ordering is done on numbers: string comparison of timestamps happens to work
// for this one format and stops working the moment a row carries an offset.
//
// The arithmetic is done here rather than handed to Date.parse so that one
// history yields one window everywhere. A string with an explicit offset names
// an instant and we honour it. A string without one names an instant only
// relative to a clock we cannot see, and we read it as UTC: that is what every
// row main.js writes actually is (main.js:5512 writes toISOString), and the
// alternative is not "more correct", it is the reader's own timezone leaking
// into a figure the author published. A string that does not name a time of
// day at all is refused rather than assigned midnight, because a receipt
// window is published to the millisecond and a bare date is not one.
//
// Date.UTC does the epoch conversion and toISOString does the formatting.
// Neither reads the host zone, so this stays as pure as the rest of the file.
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
  // Fractions are truncated to milliseconds rather than rounded: rounding
  // ".9996" up would move the stamp past the instant the row recorded, and a
  // window that overshoots is the one error a reader cannot detect.
  const millis = m[7] === undefined ? 0 : Number(`${m[7]}000`.slice(0, 3));

  // Date.UTC maps years 0..99 onto 1900..1999, so "0026-..." would silently
  // become 1926 and pass every check downstream. A row from the first
  // millennium is a corrupted field, not a run, and is refused as one.
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
  // The year check above ran on the digits as written, which is where it has to
  // run, but the offset is applied after it. Re-refuse the first millennium on
  // the instant so a corrupted field cannot walk through the guard by carrying
  // an offset that pushes it back across the boundary.
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
// spellings are accepted: main.js normalizes claude's stream-json usage to
// camelCase on the autopilot path (main.js:2195-2199) and that is the contract
// for a run row, but the underlying event carries snake_case and a row written
// straight from one would otherwise read as "reported nothing".
//
// A record with a field present but unusable is rejected whole rather than
// partially trusted. Half a usage record is not a smaller usage record, it is
// evidence that something wrote this file badly, and the honest response to
// that is to drop the run from the token sample.
function readUsage(u) {
  if (!isObject(u)) return null;
  // A JSON null is an absence, the same as a missing key, so it falls through
  // to the other spelling instead of standing in front of it. A row that
  // carries a normalized `input: null` next to the raw `input_tokens: 500` is
  // exactly what a writer that always emits the camelCase shape and copies the
  // event across produces, and reading the null there would drop the number
  // sitting beside it while every other tier in the same record read fine. That
  // is a quietly under-reported total, which is the one outcome this function's
  // reject-the-record-whole rule exists to avoid.
  //
  // Each spelling is read once into a local. Reading u[a] twice would let a row
  // with an accessor answer the test with one value and the assignment with
  // another, and this is the gate every token figure in the module comes
  // through.
  //
  // Zero falls through too, and only to a sibling that carries a real count.
  // A writer that initialises a zeroed camelCase accumulator and persists it
  // beside the raw event is the shape `ms` already has in this codebase
  // (main.js:5343 writes `st.ms || 0`), so a strict null-only test reads that
  // row as four zeros. Forty lines below, totalOrNull calls four zeros no
  // report at all, so the 5200 tokens sitting in the snake_case fields next to
  // them are never looked at and the run publishes as having reported nothing.
  // That is the exact outcome reading both spellings exists to prevent. A zero
  // with no counted sibling still reads as the zero it is.
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
// Null is the answer for every vendor except claude, because claude is the
// only one Husk runs with --output-format stream-json and therefore the only
// one whose usage it can read (main.js:5696). Reporting zeros for the other
// four would publish "this workflow used no tokens", which is a measurement
// nobody took. That is why a record whose four fields are all zero is treated
// as no report at all: a run that genuinely moved zero tokens did not happen.
function runTokens(row) {
  // The run-level total wins only when it actually says something. Branching on
  // whether readUsage produced a record rather than on whether that record
  // reported anything makes four zeros beat the steps, and four zeros are the
  // one case the rule above calls no report at all: the fallback exists for
  // precisely this row. It is reachable from plain JSON with no exotic objects,
  // because a writer that initialises a zero accumulator and always persists it
  // is the shape `ms` already has (main.js:5343 writes `st.ms || 0` and falls
  // back to 0), so keying on presence would turn every claude run's
  // medianTokens into null while the steps underneath carry the real numbers.
  // A tokens field that is present and unreadable is not the same fact as no
  // tokens field, and only the second one may fall through to the steps.
  // readUsage's own contract is that it rejects a record whole rather than
  // trusting half of it, because half a usage record is evidence the file was
  // written badly. Treating its null as absence quietly undoes that: a row whose
  // run total claims 5000 input tokens in a shape we refused would be
  // republished at whatever its steps happened to add up to, with nothing
  // anywhere recording that the authoritative figure was thrown out.
  const hasDirect = isObject(row.tokens);
  const direct = hasDirect ? readUsage(row.tokens) : null;
  if (hasDirect && !direct) return null;
  const directTotal = direct ? totalOrNull(direct) : null;
  if (directTotal) return directTotal;

  const steps = Array.isArray(row.steps) ? row.steps : [];
  const n = stepCount(steps);
  const sum = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let sawAny = false;
  // Indexed over a count read once, matching isCensored and the outer walk. A
  // bound in only one of the two inner walks does not remove the hazard, it
  // just moves a row that grows as it is read to the other one.
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
  // Indexed, over a count read once, for the reason MAX_RUN_STEPS states. The
  // count is re-read here rather than passed in because a list that grows under
  // the first walk would otherwise hand the second one a stale bound, and a
  // bound the input can influence is not a bound.
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
// than the budget allows. Null is a refusal for the whole row rather than a
// clamp, because a token total taken over the first N of an unknown number of
// steps is a smaller number wearing the presentation of a complete one.
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
// is described by that fact first: the workflow was not given the chance to
// fail. A run with a killed step is reported as timedOut rather than failed
// because the kill is what produced the non-zero exit, and calling it a plain
// failure hides the one thing a reader needs to know about the duration figure
// sitting next to it.
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
// Folding both limits through `safeCount(x) || DEFAULT` is wrong twice over. It
// discards a typo in silence, so a caller who writes "60000" as a string gets
// the 300 second default and no hint that its argument was discarded, while
// every other input in this file refuses by name. And it discards zero, which
// is the one value with a real meaning here: a stepTimeoutMs of 0 says "treat
// any failed step as censored", and a historyMax of 0 says "assume this list
// was already trimmed".
function readLimit(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return safeCount(value);
}

// How many rows the source list declares it has, measured once, before a single
// row has been read out of it.
//
// Array.isArray is satisfied by a Proxy whose target is an array, and `length`
// is a writable property, so its get trap is under no invariant and may return
// a string, a NaN, a different number each time, or throw. safeCount answers
// the first three and the try answers the last; a list we cannot measure is
// read as empty, which produces an honest aggregate of nothing rather than a
// refusal the caller has no way to act on.
//
// Taking the measurement once is the point. Everything downstream is stated
// against this single number: the walk's stopping point, the unread bucket, and
// the sourceRuns the caller is invited to reconcile against them. Re-reading
// length as the walk goes lets a row that appends to the list while it is being
// read walk forever, since the array iterator consults length on every step,
// and it lets a list that shrinks under the walk leave the ledger holding an
// unnamed remainder.
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
// Every property access a row could raise on lives in this one function, so the
// loop below can wrap a single call and know that a row which raises has cost
// itself its place and nothing else. It also commits nothing:
// the counters are touched only after this has returned, so a row that throws
// halfway through cannot leave `runs` and the outcome tally disagreeing, and
// the wire format requires those two to agree exactly.
function readRow(row, workflowId, graphHash, stepTimeoutMs) {
  if (!isObject(row)) return { excluded: 'malformed' };
  // A row carrying no id at all is a truncated or corrupt record. Counting it
  // as another workflow's history would have the surface tell the reader a
  // story about workflows they may not even have.
  if (typeof row.workflowId !== 'string' || !row.workflowId) return { excluded: 'malformed' };
  if (row.workflowId !== workflowId) return { excluded: 'otherWorkflow' };
  // A row with no fingerprint at all is history recorded without one, which is
  // a different fact from a row that names a different graph. Counting the two
  // apart lets a surface say "9 earlier runs predate this" rather than implying
  // the author edited the workflow.
  if (typeof row.graphHash !== 'string' || !row.graphHash) return { excluded: 'unhashed' };
  if (row.graphHash !== graphHash) return { excluded: 'otherGraph' };

  // A row whose step list is longer than any walk will read cannot contribute a
  // duration or a token figure, because both would be taken over a prefix and
  // published as totals. The gate sits here, before either walk, so a list that
  // only claims to be enormous costs one length read rather than a pinned core.
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
// Whether the result can go on the wire at all is answered by `publishable`
// and, when it cannot, by the field names in `publishBlockers`. The caller is
// not asked to re-derive that from three nullable fields and a count: runs of
// 0, runs past the schema's ceiling, a window nothing datable was found for, a
// duration nothing timed, and a median longer than the schema's hour are five
// different reasons and each one says its own name.
function aggregateRuns(runs, opts) {
  // The whole computation sits under one guard because the alternative is a
  // library that throws, and a validator that throws is a validator that took
  // the app down with it. The per-row reads are contained individually below;
  // this catches what is left, which is mostly opts itself fighting back
  // before there is any aggregate to speak of. The exception is not quoted
  // back: its message came from the same input we are refusing, and it would
  // be rendered by a surface that has no reason to trust it.
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
  // tail: we keep the runs closest to the graph as it stands today. The cut is
  // made by where this loop stops counting, not by asking the list for a
  // shorter copy of itself, so the bound holds for a container that defines its
  // own slice and for one that grows while it is being read.
  const sourceRuns = sourceLength(runs);
  const walked = sourceRuns > MAX_SOURCE_RUNS ? MAX_SOURCE_RUNS : sourceRuns;

  const outcomes = { completed: 0, failed: 0, stopped: 0, timedOut: 0 };
  // `unread` holds the rows past the hard cap, which were never looked at.
  // sourceRuns and excluded are published side by side as "what we looked at
  // and what we set aside", which invites a surface to subtract one from the
  // other, and without this bucket that subtraction leaves a remainder with no
  // name on it whenever the cap fires.
  //
  // Both ends of that subtraction come from the one length reading, so the
  // bucket is a difference between a number and a clamp of itself and cannot
  // come out negative. Taking it instead as sourceRuns minus the length of
  // whatever the container's own slice hands back makes it a relationship the
  // input gets to choose: a slice that returns a longer list than it was given
  // publishes an excluded count of -10001, and no receipts strip can draw that.
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

  // Indexed rather than for-of, and over a count fixed before the first read.
  // The array iterator asks the list how long it is at every step, which makes
  // a row whose own accessor appends to the list an unbounded loop that no
  // try/catch can interrupt: nothing throws, it simply never returns, and the
  // thread it never returns to is the Electron main one. Every position we do
  // read is accounted for below whether or not anything was there, so a list
  // that shrinks under the walk fills the vacated slots with `malformed` and
  // the ledger still closes.
  //
  // The subscript itself is inside the guard along with the read. On a proxied
  // list an index get is as capable of raising as any of the property reads
  // readRow performs, and a row that fights back is meant to cost itself its
  // place in the tally and nothing else.
  for (let i = 0; i < walked; i += 1) {
    let read;
    try {
      read = readRow(runs[i], workflowId, graphHash, stepTimeoutMs);
    } catch (_) {
      // A row that raises on being read is malformed in the only sense this
      // module cares about: we could not learn anything from it. It is counted
      // with the nulls and the strings rather than aborting the other 30 runs,
      // which are perfectly good evidence about the same workflow.
      read = { excluded: 'malformed' };
    }
    if (read.excluded) { excluded[read.excluded] += 1; continue; }

    matched += 1;
    outcomes[read.bucket] += 1;
    if (read.censored) durationCensored += 1;

    // Censored and cancelled runs stay in the duration sample. Dropping them
    // would silently change the denominator behind the median while `runs`
    // kept reporting the full count, and the disclosure fields exist so the
    // reader can discount the figure themselves.
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
  // does, because independent medians can each land on zero over runs that
  // every one of them reported real usage for: three runs reporting one
  // nonzero tier each produce four zero medians. Published as zeros that reads
  // as "this workflow moves no tokens", and downstream it is worse than null,
  // since a rate table multiplied by zeros renders a confident free rather
  // than a suppressed figure. medianTokensN keeps the honest count either way,
  // so null with a count above zero is distinguishable from nobody reporting.
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
  // The schema's range on `runs` has two ends and this checks both. The walk's
  // own bound makes the upper one unreachable today, which is the point: the
  // wire limit is asserted where publishability is decided instead of being an
  // emergent property of how far a loop somewhere above happened to get. When
  // the two constants stop being the same number, this is what notices.
  if (matched > MAX_RECEIPT_RUNS) publishBlockers.push('runsExceedsMax');
  if (runWindow === null) publishBlockers.push('window');
  if (medianDurationMs === null) publishBlockers.push('medianDurationMs');
  if (medianDurationExceedsMax) publishBlockers.push('medianDurationExceedsMax');

  const aggregate = {
    workflowId,
    graphHash,
    runs: matched,
    // True when the history we read from had already been trimmed, so the
    // window below describes what survived rather than everything that ran.
    // At exactly historyMax the two cases are indistinguishable and we take
    // the conservative one: claiming a complete record we cannot prove is the
    // worse error.
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
    // rule, and a range needs its two ends. Kept off the wire because a spread
    // that degrades honestly at n=2 has not been designed yet.
    // Reduced rather than spread into Math.min/Math.max: a spread over a long
    // history is the RangeError that already lurks in wfMiniGraph, and this
    // list is caller-supplied.
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
    // What we looked at and what we set aside, so a surface can explain a thin
    // receipt instead of leaving the reader to assume the workflow was barely
    // used. runs plus the excluded buckets equals sourceRuns exactly, so the
    // subtraction this pairing invites always comes out at zero.
    sourceRuns,
    excluded,
  };
  return { ok: true, aggregate };
}

// ─── figures from a shipped log ──────────────────────────────────────────────

// The workflow id the reconstructed rows are keyed on.
//
// A published log carries no workflow id and must not: the author's local
// `wf-1762...` says nothing to a reader and the binding row already names the
// only identity that matters, which is the fingerprint of the graph that ran.
// aggregateRuns filters on both, so the reconstruction gives every row the same
// literal and hands the same one back in. The filter still runs; it just cannot
// exclude anything, which is correct, because a log's rows are the rows.
const CHAIN_WORKFLOW_ID = 'husk.chain';

// figuresFromChain(sessions) recomputes a receipt's figures from the audit rows
// shipped inside the file.
//
// `sessions` is verifyArtifactChain's output: one entry per session, each with
// the parsed rows of one run in order. This is the half of the feature that
// makes "matches the shipped log" mean anything. The publisher builds the
// declared figures with this function and the reader recomputes them with the
// same one, so a disagreement can only ever be a file that was edited between
// the two, never two implementations of a median drifting apart. That is also
// why the reconstruction goes back through aggregateRuns rather than adding up
// rows directly: there is exactly one definition of a censored run, of an
// outcome bucket and of a token total in this codebase, and it is above.
//
// Three figures are deliberately not derived here. `runsWindowed` is a fact
// about the author's run history, which a log cannot see. `environment` is what
// their machine was, which no row can prove. The run window is derived, because
// the rows carry the timestamps, but it stays in the author-states tier
// wherever it is rendered: a clock is as author-controlled as the rest of the
// file, and checking it against itself would dress a tautology as a finding.
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
    // this is the same rule stated where the arithmetic happens, so calling
    // this function directly cannot aggregate two programs into one figure.
    if (graphHash !== null && built.row.graphHash !== graphHash) {
      return { ok: false, error: 'the sessions in this log were run against different workflows' };
    }
    graphHash = built.row.graphHash;
    rows.push(built.row);
  }

  const agg = aggregateRuns(rows, {
    workflowId: CHAIN_WORKFLOW_ID,
    graphHash,
    // The rows are the rows: a log is not a window onto a longer history, it is
    // the whole of what was shipped. Stating the cap above the count keeps
    // runsWindowed false rather than letting the default make a claim about a
    // history this side of the wire has never seen.
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
// The rows were parsed by the chain walk, which means they are plain JSON and
// not live objects with accessors, so this reads them directly. What it does
// not do is trust their contents: a payload field that is missing or the wrong
// type simply does not contribute, and the aggregation upstream already treats
// an unreadable duration as a run that does not vote on the median rather than
// as a run that took zero milliseconds.
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
// These five and no others. The window and `runsWindowed` are excluded because
// they are permanently author-stated: comparing an author's timestamps against
// the same author's timestamps would produce a finding out of a tautology, and
// a mismatch there would collapse a receipt over a fact the tier table says
// nobody ever claimed to have checked. `environment` is excluded for the
// stronger version of the same reason, since no row can carry proof of the
// machine it was written on.
const COMPARED_FIELDS = ['runs', 'outcomes', 'medianDurationMs', 'durationCensored', 'medianTokens'];

// compareFigures(receipt, figures) answers whether a receipt says what its own
// log says. Disagreement is not a caveat to render beside the numbers: the
// caller collapses the whole receipt block, because a figure contradicted by
// the evidence attached to it is worse than a figure with no evidence at all.
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
// both sides, because key order would decide the answer and a receipt that
// arrived through JSON.parse carries the author's key order, not ours.
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
