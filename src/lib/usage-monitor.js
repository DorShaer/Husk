'use strict';

// Wrapped: this file is also loaded as a classic renderer script.
(function () {

// Usage monitor. Pure: readings from named sources go in, a state per source
// and overall comes out. No clock, no fs; callers pass timestamps.
//
// A reading: { id, kind, label, detail?, used, limit, unit?, resetsAt?, reached?, inferred?, readOnly? }
//   kind: 'plan' | 'context' | 'budget' | 'autopilot'
//   used / limit share one unit; resetsAt is epoch ms.

const STATES = ['ok', 'close', 'critical', 'reached'];
const DEFAULT_THRESHOLDS = Object.freeze({ close: 75, critical: 90 });

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Thresholds are preferences, so they arrive untyped. Anything outside
// 1..99, or a close value at or above critical, falls back to the default.
function normalizeThresholds(t) {
  const close = num(t && t.close);
  const critical = num(t && t.critical);
  const ok = (v) => Number.isInteger(v) && v >= 1 && v <= 99;
  const out = { close: ok(close) ? close : DEFAULT_THRESHOLDS.close, critical: ok(critical) ? critical : DEFAULT_THRESHOLDS.critical };
  if (out.close >= out.critical) return { close: DEFAULT_THRESHOLDS.close, critical: DEFAULT_THRESHOLDS.critical };
  return out;
}

function stateForPct(pct, thresholds) {
  const t = normalizeThresholds(thresholds);
  const p = num(pct);
  if (p >= 100) return 'reached';
  if (p >= t.critical) return 'critical';
  if (p >= t.close) return 'close';
  return 'ok';
}

function rank(state) { const i = STATES.indexOf(state); return i === -1 ? 0 : i; }

// evaluate folds readings into { sources, overall, attention }. A reading
// whose reset time has passed starts over at zero: the window it measured is
// gone, and the next reading replaces it.
function evaluate(readings, thresholds, now) {
  const t = normalizeThresholds(thresholds);
  const at = num(now);
  const sources = [];
  for (const r of Array.isArray(readings) ? readings : []) {
    if (!r || !r.id) continue;
    const limit = num(r.limit);
    const resetsAt = num(r.resetsAt);
    const rolled = resetsAt > 0 && at > 0 && resetsAt <= at;
    const used = rolled ? 0 : Math.max(0, num(r.used));
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    const reached = !rolled && !!r.reached;
    if (limit <= 0 && !reached) continue;
    sources.push(Object.assign({}, r, {
      used, limit, pct,
      resetsAt: rolled ? 0 : resetsAt,
      reached,
      state: reached ? 'reached' : stateForPct(pct, t),
    }));
  }
  let overall = 'ok';
  let attention = 0;
  for (const s of sources) {
    if (rank(s.state) > rank(overall)) overall = s.state;
    if (s.state !== 'ok') attention += 1;
  }
  return { sources, overall, attention, thresholds: t };
}

// crossings lists the sources whose state got worse between two evaluations.
function crossings(prev, next) {
  const before = new Map();
  for (const s of (prev && prev.sources) || []) before.set(s.id, s.state);
  return ((next && next.sources) || []).filter((s) => rank(s.state) > rank(before.get(s.id) || 'ok'));
}

// ─── the user's own daily budget ─────────────────────────────────────────────

function dayKey(now) {
  const d = new Date(num(now));
  const p = (x) => (x < 10 ? '0' : '') + x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function nextLocalMidnight(now) {
  const d = new Date(num(now));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

// A counter from another local day reads as zero.
function dailyCounter(stored, now) {
  const day = dayKey(now);
  const s = stored && typeof stored === 'object' && stored.day === day ? stored : {};
  return { day, tokens: Math.max(0, num(s.tokens)), dollars: Math.max(0, num(s.dollars)) };
}

function addDaily(stored, delta, now) {
  const c = dailyCounter(stored, now);
  return { day: c.day, tokens: c.tokens + Math.max(0, num(delta && delta.tokens)), dollars: c.dollars + Math.max(0, num(delta && delta.dollars)) };
}

// Tokens reported for a turn, including cached input.
function turnTokens(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  return Math.max(0, num(u.input_tokens)) + Math.max(0, num(u.output_tokens)) + Math.max(0, num(u.cache_creation_input_tokens)) + Math.max(0, num(u.cache_read_input_tokens));
}

// Converts session counters and per-turn usage into increments.
function usageDelta(previous, event) {
  const state = { ...(previous || {}) };
  let tokens = 0;
  let dollars = 0;
  if (event.type === 'session' && event.sessionId) {
    if (state.sessionId && state.sessionId !== event.sessionId) { state.total = 0; state.awaitingBaseline = false; }
    state.sessionId = event.sessionId;
  } else if (event.type === 'billing') state.subscription = event.plan === 'subscription';
  else if (event.type === 'turn_end') {
    tokens = turnTokens(event.usage);
    if (!state.subscription) dollars = Math.max(0, num(event.costUsd));
  } else if (event.type === 'usage' && Number.isFinite(event.total) && event.total >= 0) {
    tokens = state.awaitingBaseline ? 0 : Math.max(0, event.total - num(state.total));
    state.total = event.total;
    state.awaitingBaseline = false;
  }
  return { state, tokens, dollars };
}

function budgetReadings(counter, budget, now) {
  const out = [];
  const b = budget || {};
  const reset = nextLocalMidnight(now);
  if (num(b.tokens) > 0) out.push({ id: 'budget:tokens', kind: 'budget', label: 'Daily token budget', used: num(counter && counter.tokens), limit: num(b.tokens), unit: 'tokens', resetsAt: reset });
  if (num(b.dollars) > 0) out.push({ id: 'budget:dollars', kind: 'budget', label: 'Daily dollar budget', used: num(counter && counter.dollars), limit: num(b.dollars), unit: 'dollars', resetsAt: reset });
  return out;
}

// ─── plan limits ─────────────────────────────────────────────────────────────

const WINDOW_LABEL = { short: 'Short window', weekly: 'Weekly window', plan: 'Plan limit', possible: 'Possible limit' };

// windows: [{ window: 'short' | 'weekly', pct, resetsAt, reached?, inferred? }]
function planReadings(agent, windows) {
  const out = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || !WINDOW_LABEL[w.window]) continue;
    out.push({
      id: 'plan:' + agent + ':' + w.window, kind: 'plan', label: WINDOW_LABEL[w.window], detail: agent,
      used: num(w.pct), limit: 100, unit: 'percent', resetsAt: num(w.resetsAt), reached: !!w.reached, inferred: !!w.inferred,
    });
  }
  return out;
}

// The plan usage endpoint's reply as the cache file's fields. extra_usage
// amounts are minor units of its currency.
function planCacheFields(data, prior, fetchedAt) {
  const d = data && typeof data === 'object' ? data : {};
  const p = prior && typeof prior === 'object' ? prior : {};
  const fh = d.five_hour || {};
  const sd = d.seven_day || null;
  const iso = (s) => (typeof s === 'string' && /^[0-9T:\-+.Z]{1,40}$/.test(s) ? s : '');
  const wsCents = d.workspace_cost && typeof d.workspace_cost.month_used_cents === 'number' ? d.workspace_cost.month_used_cents : null;
  const priorWs = typeof p.ws_cost_dollars !== 'undefined' ? String(p.ws_cost_dollars).slice(0, 16) : 0;
  const priorSession = typeof p.session_cost === 'string' ? p.session_cost.slice(0, 32) : '';
  const ex = d.extra_usage && typeof d.extra_usage === 'object' && d.extra_usage.is_enabled ? d.extra_usage : null;
  const dollars = (minor) => (typeof minor === 'number' && Number.isFinite(minor) && minor > 0 ? Number((minor / 100).toFixed(2)) : 0);
  return {
    usage_5h: Number(fh.utilization || 0),
    usage_7d: Number((sd && sd.utilization) || 0),
    reset_5h_clock: iso(fh.resets_at),
    reset_7d_clock: sd ? iso(sd.resets_at) : '',
    ws_cost_dollars: String(wsCents !== null ? (wsCents / 100).toFixed(2) : priorWs).slice(0, 16),
    session_cost: typeof d.session_cost === 'string' ? d.session_cost.slice(0, 32) : priorSession,
    extra_used_dollars: ex ? dollars(ex.used_credits) : 0,
    extra_limit_dollars: ex ? dollars(ex.monthly_limit) : 0,
    fetched_at: String(fetchedAt || ''),
  };
}

// ─── inferred limits ─────────────────────────────────────────────────────────

// A short list on purpose: a miss costs nothing, a false match tells the user
// a limit was hit when it was not.
const LIMIT_PHRASES = [
  /\brate[ _-]?limit/i,
  /\busage limit\b/i,
  /\bquota (?:exceeded|exhausted)\b/i,
  /\bexceeded your (?:current )?quota\b/i,
  /\bresource[_ ]exhausted\b/i,
  /\btoo many requests\b/i,
];

function matchLimitPhrase(text) {
  const s = String(text == null ? '' : text);
  if (!s || s.length > 4000) return false;
  return LIMIT_PHRASES.some((re) => re.test(s));
}

(function publish(exports) {
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  if (typeof window !== 'undefined') window.HuskUsage = exports;
})({
  STATES, DEFAULT_THRESHOLDS, normalizeThresholds, stateForPct, evaluate, crossings,
  dayKey, nextLocalMidnight, dailyCounter, addDaily, turnTokens, usageDelta, budgetReadings,
  planReadings, planCacheFields, matchLimitPhrase,
});
})();
