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
  // model id -> { in: $/Mtok, out: $/Mtok }
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-7': { in: 3, out: 15 },
  'claude-opus-4-6':   { in: 15, out: 75 },
  'claude-opus-4-7':   { in: 15, out: 75 },
  'claude-haiku-4-5':  { in: 0.8, out: 4 },
  // GitHub Copilot / Codex / Aider: vendor-billed. Treat dollars as
  // 0 by default so the dollar cap never fires there; supervisor can
  // override per-tool.
  'copilot':           { in: 0, out: 0 },
  'codex':             { in: 0, out: 0 },
  'aider':             { in: 0, out: 0 },
  '_default':          { in: 3, out: 15 },
});

function createBudgetMeter(opts = {}) {
  const caps = Object.assign({}, DEFAULT_CAPS, opts.caps || {});
  if (!Number.isFinite(caps.minutes) || caps.minutes < 0) caps.minutes = DEFAULT_CAPS.minutes;
  if (!Number.isFinite(caps.tokens)  || caps.tokens  < 0) caps.tokens  = DEFAULT_CAPS.tokens;
  if (!Number.isFinite(caps.dollars) || caps.dollars < 0) caps.dollars = DEFAULT_CAPS.dollars;

  const rates = Object.assign({}, DEFAULT_RATES, opts.rates || {});
  const modelId = typeof opts.modelId === 'string' && opts.modelId ? opts.modelId : '_default';
  const rate = rates[modelId] || rates._default;

  const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedFlag = false;
  let lastTickAt = startedAt;

  // tick({ now?, inputTokens?, outputTokens?, charsFromAgent? })
  // Returns the post-tick state. charsFromAgent is the optional
  // fallback signal (when a CLI does not report tokens, the
  // supervisor passes the byte count of model output and we divide
  // by 4 to estimate output tokens).
  function tick(input = {}) {
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    if (Number.isFinite(input.inputTokens))  inputTokens  += Math.max(0, input.inputTokens);
    if (Number.isFinite(input.outputTokens)) outputTokens += Math.max(0, input.outputTokens);
    if ((!Number.isFinite(input.inputTokens) && !Number.isFinite(input.outputTokens))
        && Number.isFinite(input.charsFromAgent) && input.charsFromAgent > 0) {
      outputTokens += Math.floor(input.charsFromAgent / 4);
      estimatedFlag = true;
    }
    lastTickAt = now;
    return state(now);
  }

  function state(nowParam) {
    const now = Number.isFinite(nowParam) ? nowParam : Date.now();
    const elapsedMs = Math.max(0, now - startedAt);
    const elapsedMinutes = elapsedMs / 60000;
    const totalTokens = inputTokens + outputTokens;
    const dollars = (inputTokens / 1e6) * rate.in + (outputTokens / 1e6) * rate.out;
    return {
      caps: { ...caps },
      modelId,
      rate: { ...rate },
      elapsedMs,
      elapsedMinutes,
      inputTokens,
      outputTokens,
      totalTokens,
      tokensEstimated: estimatedFlag,
      dollars,
      ratios: {
        minutes: caps.minutes > 0 ? Math.min(1, elapsedMinutes / caps.minutes) : 0,
        tokens:  caps.tokens  > 0 ? Math.min(1, totalTokens   / caps.tokens)  : 0,
        dollars: caps.dollars > 0 ? Math.min(1, dollars       / caps.dollars) : 0,
      },
      hitCap: firstHitCap(elapsedMinutes, totalTokens, dollars, caps),
    };
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
    startedAt() { return startedAt; },
    lastTickAt() { return lastTickAt; },
  };
}

module.exports = {
  DEFAULT_CAPS,
  DEFAULT_RATES,
  createBudgetMeter,
};
