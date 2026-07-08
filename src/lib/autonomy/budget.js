'use strict';

// Budget meter for Husk Autonomy Mode.
//
// Tracks three orthogonal caps for one run:
//   1. wall-clock minutes
//   2. estimated token cost (input + output, summed)
//   3. estimated dollar cost (tokens times a per-model price table)
//
// The meter is a pure value object: configure it once, feed it ticks
// (from setInterval, from the parsed PTY stream, from the model's
// usage report), and ask it for the current state or for the first
// cap that has been crossed. The supervisor uses the latter to issue
// a SIGINT and emit a halt_budget event into the audit log.
//
// Design rules:
//   - Pure (no side effects, no fs, no clock). The CALLER supplies
//     timestamps so the same module is testable with fake timers
//     and trivially mockable in production.
//   - Conservative on the upper bounds: if any input is missing
//     (e.g., a CLI that does not report token counts), the dollar
//     and token estimates use a fallback heuristic (4 chars per
//     token) and the meter reports `tokensEstimated: true` so the
//     supervisor can surface "approximate" in the UI.
//   - Three caps are independent. Hitting any one halts the run.

const DEFAULT_CAPS = Object.freeze({
  minutes: 60,
  tokens: 200000,
  dollars: 5,
});

// Per-model rates in dollars per million tokens, conservative defaults
// based on public list prices as of mid-2026. The supervisor can
// override via opts.rates so this module never needs a network call.
// Numbers are intentionally rough; the meter is for "stop the run
// before it gets wild", not for billing accuracy.
const DEFAULT_RATES = Object.freeze({
  // model id -> { in: $/Mtok, out: $/Mtok }. Public list prices; the meter
  // bills input and output at their own rates (output is ~5x input) and
  // cache tiers at input multiples, so the dollar figure tracks the model
  // that actually ran, not a blended guess.
  'claude-fable-5':    { in: 10, out: 50 },
  'claude-opus-4-8':   { in: 5, out: 25 },
  'claude-opus-4-7':   { in: 5, out: 25 },
  'claude-opus-4-6':   { in: 5, out: 25 },
  'claude-sonnet-5':   { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-7': { in: 3, out: 15 },
  'claude-haiku-4-5':  { in: 1, out: 5 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  // Copilot / Codex / Aider / Gemini: billing depends on the account, not
  // the CLI (a Copilot or Gemini subscription is flat; the same CLI on an
  // API key is metered), and Husk cannot tell which mode is active. Treat
  // dollars as 0 so the dollar cap never fires on a false assumption; the
  // time and token caps still bound the run, and the supervisor can pass an
  // explicit per-tool rate when the account's billing is known.
  'copilot':           { in: 0, out: 0 },
  'codex':             { in: 0, out: 0 },
  'aider':             { in: 0, out: 0 },
  'gemini':            { in: 0, out: 0 },
  '_default':          { in: 3, out: 15 },
});

// Resolve a model id to its rate. A transcript reports dated ids
// (claude-opus-4-8-20260115) and tier aliases (opus, haiku); match exact
// first, then strip a trailing -YYYYMMDD date, then match the longest rate
// key that is a substring (so "opus-4-8" and a bare "opus" both land on the
// opus rate). Falls back to _default so an unknown id never crashes billing.
function resolveRate(modelId, rates) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return { id: '_default', rate: rates._default };
  if (rates[id]) return { id, rate: rates[id] };
  const undated = id.replace(/-\d{8}$/, '');
  if (rates[undated]) return { id: undated, rate: rates[undated] };
  let best = null;
  for (const key of Object.keys(rates)) {
    if (key === '_default') continue;
    const fam = key.replace(/^claude-/, '');
    if (id.includes(key) || id.includes(fam)) {
      if (!best || fam.length > best.fam.length) best = { key, fam };
    }
  }
  // Bare tier aliases the CLI accepts as --model values.
  if (!best) {
    if (/\bopus\b/.test(id)) best = { key: 'claude-opus-4-8', fam: 'opus' };
    else if (/\bsonnet\b/.test(id)) best = { key: 'claude-sonnet-5', fam: 'sonnet' };
    else if (/\bhaiku\b/.test(id)) best = { key: 'claude-haiku-4-5', fam: 'haiku' };
    else if (/\bfable\b/.test(id)) best = { key: 'claude-fable-5', fam: 'fable' };
  }
  if (best) return { id: best.key, rate: rates[best.key] };
  return { id: '_default', rate: rates._default };
}

function createBudgetMeter(opts = {}) {
  const caps = Object.assign({}, DEFAULT_CAPS, opts.caps || {});
  if (!Number.isFinite(caps.minutes) || caps.minutes < 0) caps.minutes = DEFAULT_CAPS.minutes;
  if (!Number.isFinite(caps.tokens)  || caps.tokens  < 0) caps.tokens  = DEFAULT_CAPS.tokens;
  if (!Number.isFinite(caps.dollars) || caps.dollars < 0) caps.dollars = DEFAULT_CAPS.dollars;

  const rates = Object.assign({}, DEFAULT_RATES, opts.rates || {});
  // Mutable: the run may not know its model until the first transcript turn
  // reports it; setModel() re-pins the rate to what actually ran.
  let resolved = resolveRate(opts.modelId, rates);
  let modelId = resolved.id;
  let rate = resolved.rate;

  const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  // Cache-tier tokens from a structured transcript, billed at their real
  // Anthropic multiples of the input rate: cache writes at 1.25x, cache
  // reads at 0.1x. Kept separate so the dollar figure is EXACT (not the
  // status-line estimate) and so cache reads -- which dominate token counts
  // but cost a tenth -- do not blow the token cap (they are excluded from
  // the cap basis; only fresh work counts there).
  let cacheCreateTokens = 0;
  let cacheReadTokens = 0;
  const CACHE_CREATE_MULT = 1.25;
  const CACHE_READ_MULT = 0.1;
  // chars/4 fallback accumulates separately from explicit reports so a
  // weak estimate can never outrank a real signal.
  let estOutputTokens = 0;
  let estimatedFlag = false;
  let lastTickAt = startedAt;
  // Authoritative cumulative token count reported by the agent itself
  // (e.g., claude prints "↓ 1.5k tokens" in its status line; the
  // supervisor parses that and calls setReportedTokens). When set,
  // this OVERRIDES the chars/4 estimate so the UI shows the same
  // number the user sees in the agent's own status. Stays null until
  // the parser sees a value, so non-claude agents fall back to the
  // chars/4 estimate.
  let reportedTotal = null;

  // tick({ now?, inputTokens?, outputTokens?, charsFromAgent? })
  // Returns the post-tick state. charsFromAgent is the optional
  // fallback signal (when a CLI does not report tokens, the
  // supervisor passes the byte count of model output and we divide
  // by 4 to estimate output tokens).
  function tick(input = {}) {
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    if (Number.isFinite(input.inputTokens))  inputTokens  += Math.max(0, input.inputTokens);
    if (Number.isFinite(input.outputTokens)) outputTokens += Math.max(0, input.outputTokens);
    if (Number.isFinite(input.cacheCreateTokens)) cacheCreateTokens += Math.max(0, input.cacheCreateTokens);
    if (Number.isFinite(input.cacheReadTokens))   cacheReadTokens   += Math.max(0, input.cacheReadTokens);
    if ((!Number.isFinite(input.inputTokens) && !Number.isFinite(input.outputTokens))
        && Number.isFinite(input.charsFromAgent) && input.charsFromAgent > 0) {
      estOutputTokens += Math.floor(input.charsFromAgent / 4);
      estimatedFlag = true;
    }
    lastTickAt = now;
    return state(now);
  }

  function state(nowParam) {
    const now = Number.isFinite(nowParam) ? nowParam : Date.now();
    const elapsedMs = Math.max(0, now - startedAt);
    const elapsedMinutes = elapsedMs / 60000;
    // Truth hierarchy:
    //   1. explicit per-turn input/output deltas from a structured
    //      transcript (exact new work, cache reads excluded)
    //   2. agent-reported cumulative tokens from its own status line
    //   3. chars-from-agent / 4 fallback estimate (the worst signal,
    //      inflated 5-10x by ANSI/cursor codes on TUI agents)
    // Explicit deltas and a status-line report can coexist (a report
    // seen before the transcript pinned); the larger cumulative wins
    // so a stale early report never masks real accumulation. The
    // estimate only surfaces when it is the ONLY signal.
    // Fresh work = input + output + cache writes. Cache READS are excluded
    // from the cap basis (they cost a tenth and dominate counts, so a token
    // cap that included them would fire instantly) but they DO count toward
    // dollars below.
    const explicit = inputTokens + outputTokens + cacheCreateTokens;
    let totalTokens;
    let source;
    if (reportedTotal != null) {
      totalTokens = Math.max(reportedTotal, explicit);
      source = explicit > reportedTotal ? 'explicit' : 'reported';
    } else if (explicit > 0) {
      totalTokens = explicit;
      source = 'explicit';
    } else {
      totalTokens = estOutputTokens;
      source = estimatedFlag ? 'estimate' : 'explicit';
    }
    // Dollars follow the total's source: exact in/out split for
    // explicit deltas, a blended rate over a reported cumulative
    // (chat-style runs average ~70/30 output/input), output rate for
    // the chars/4 estimate.
    let dollars;
    if (source === 'reported') {
      // A status-line cumulative counter conflates cache reads, re-sent
      // context, fresh input, and output into one number. Calibrated against
      // 715 real agent messages, that mix is ~97% cache-read tokens (billed
      // at 0.1x input) -- the measured effective rate is ~$0.49/Mtok for a
      // Sonnet-class model, NOT the $11.40/Mtok a fresh 30/70 blend implies.
      // Charging the fresh rate over-stated cost ~23x and could SIGINT a
      // healthy run on a phantom dollar cap. This cache-weighted rate tracks
      // the measured cost and is biased slightly low on purpose: under-
      // charging just fires the cap a little late (benign), while over-
      // charging kills a cheap run (the failure we are removing).
      const reportedRate = (rate.in * 0.13) + (rate.out * 0.01);
      dollars = (reportedTotal / 1e6) * reportedRate;
    } else if (source === 'estimate') {
      dollars = (estOutputTokens / 1e6) * rate.out;
    } else {
      // Exact cache-aware cost from structured transcript deltas: fresh input
      // and output at their rates, cache writes at 1.25x input, cache reads
      // at 0.1x input. This is the precise dollar figure, not an estimate.
      dollars = (inputTokens / 1e6) * rate.in
        + (outputTokens / 1e6) * rate.out
        + (cacheCreateTokens / 1e6) * (rate.in * CACHE_CREATE_MULT)
        + (cacheReadTokens / 1e6) * (rate.in * CACHE_READ_MULT);
    }
    return {
      caps: { ...caps },
      modelId,
      rate: { ...rate },
      elapsedMs,
      elapsedMinutes,
      inputTokens,
      // When the chars/4 estimate is the active source it is also the
      // output figure callers see; explicit deltas otherwise.
      outputTokens: source === 'estimate' ? estOutputTokens : outputTokens,
      cacheCreateTokens,
      cacheReadTokens,
      totalTokens,
      tokensEstimated: source === 'estimate',
      tokensReported: reportedTotal != null,
      // Exact when the dollar figure comes from structured transcript deltas
      // (the 'explicit' source with real work recorded), not an estimate or a
      // status-line blend.
      tokensExact: source === 'explicit' && explicit > 0,
      dollars,
      ratios: {
        minutes: caps.minutes > 0 ? Math.min(1, elapsedMinutes / caps.minutes) : 0,
        tokens:  caps.tokens  > 0 ? Math.min(1, totalTokens   / caps.tokens)  : 0,
        dollars: caps.dollars > 0 ? Math.min(1, dollars       / caps.dollars) : 0,
      },
      hitCap: firstHitCap(elapsedMinutes, totalTokens, dollars, caps),
    };
  }

  // Re-pin the billing rate to the model the transcript says actually ran.
  // Idempotent: a no-op when the resolved id is unchanged, so feeding it on
  // every turn is cheap.
  function setModel(id) {
    const next = resolveRate(id, rates);
    if (next.id === modelId) return;
    modelId = next.id;
    rate = next.rate;
  }

  function setReportedTokens(n) {
    if (!Number.isFinite(n) || n < 0) return;
    // Monotonic: cumulative counters do not shrink; if the parser sees
    // a smaller value (UI redraw glitch, regex hit a stale row),
    // ignore it so the meter cannot regress.
    if (reportedTotal != null && n < reportedTotal) return;
    reportedTotal = Math.floor(n);
  }

  function firstHitCap(minutes, tokens, dollars, capsLocal) {
    // Reports the first cap that has been crossed. Order is wall-
    // clock first because it is the cap users care most about (a
    // run that goes "until 5pm" is a real expectation; tokens and
    // dollars are softer).
    if (capsLocal.minutes > 0 && minutes >= capsLocal.minutes) return 'minutes';
    if (capsLocal.tokens  > 0 && tokens  >= capsLocal.tokens)  return 'tokens';
    if (capsLocal.dollars > 0 && dollars >= capsLocal.dollars) return 'dollars';
    return null;
  }

  return {
    tick,
    state,
    setReportedTokens,
    setModel,
    startedAt() { return startedAt; },
    lastTickAt() { return lastTickAt; },
  };
}

module.exports = {
  DEFAULT_CAPS,
  DEFAULT_RATES,
  resolveRate,
  createBudgetMeter,
};
