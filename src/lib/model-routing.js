'use strict';

// Cross-vendor model routing: pick a cheap or a smart model per task and
// translate that choice into the flag each CLI actually accepts. Mechanical
// work (bump deps, format, find TODOs) should not burn a frontier model;
// hard work should not get a weak one.
//
// Two-tier per vendor. Vendors where the model is subscription- or
// config-bound (copilot, aider) default to no flag -- the CLI's own model --
// because injecting an unknown --model would break the run, which is worse
// than not routing. Every default is overridable from settings, keyed by the
// CLI base name, so a user on any CLI version can point the tiers at the
// exact model names their install accepts.
// Per-vendor flag + tier model names. claude/gemini ship working defaults;
// codex/aider know the flag but not the model names (version/account bound),
// so they stay unrouted until the user supplies names in settings. copilot
// has no model switch at all.
// Only claude ships model-name defaults, because its --model aliases (haiku,
// opus) are documented-stable and verified. Every other CLI knows its flag
// but ships NO default names: a wrong model id fails the whole run, so the
// user confirms the exact name in settings (placeholders suggest them). This
// keeps routing safe on every CLI and automatic on claude.
const DEFAULT_VENDOR_MODELS = Object.freeze({
  claude:  { flag: '--model', cheap: 'haiku', smart: 'opus' },
  gemini:  { flag: '-m', cheap: null, smart: null },
  codex:   { flag: '--model', cheap: null, smart: null },
  aider:   { flag: '--model', cheap: null, smart: null },
  copilot: null,
});

// Return the argv fragment that selects `tier`'s model for this CLI, or []
// to leave the CLI default. overrides is a per-vendor table (from settings)
// deep-merged over the defaults, so the UI only supplies model-name strings;
// an override of null disables routing for that vendor.
function modelArgsFor(agentBaseName, tier, overrides = {}) {
  const base = String(agentBaseName || '').toLowerCase();
  const hasOv = Object.prototype.hasOwnProperty.call(overrides, base);
  if (hasOv && overrides[base] === null) return [];
  const def = DEFAULT_VENDOR_MODELS[base] || null;
  const ov = hasOv ? overrides[base] : null;
  const entry = (def || ov) ? Object.assign({}, def || {}, ov || {}) : null;
  if (!entry || !entry.flag) return [];
  const model = tier === 'cheap' ? entry.cheap : entry.smart;
  if (!model || typeof model !== 'string' || !model.trim()) return [];
  return [entry.flag, model.trim()];
}

// Classify a goal into a model tier. Conservative by design: only route DOWN
// to cheap on clearly mechanical work, default smart so a complex task never
// lands on a weak model (routing wrong toward cheap costs quality; routing
// wrong toward smart only costs tokens).
const CHEAP_RE = new RegExp(
  '\\b(bump|upgrade|update)\\b[^.]*\\b(dep|deps|dependenc\\w*|version\\w*|package\\w*)'
  + '|\\b(re)?format\\b|\\blint\\b|prettier|eslint --fix'
  + '|\\brename\\b|\\btypo\\b|sort imports|organize imports'
  + '|\\b(find|list|scan|hunt|locate|collect|gather|catalog|audit|search|grep)\\b[^.]*\\b(todo|fixme|comment)'
  + '|inventory of|add (a )?(comment|docstring|jsdoc)|changelog', 'i');

function classifyTier(goal) {
  return CHEAP_RE.test(String(goal || '')) ? 'cheap' : 'smart';
}

// Normalize a tier value from any source (planner output, config) to a valid
// tier, defaulting smart.
function normalizeTier(t) {
  return t === 'cheap' ? 'cheap' : 'smart';
}

module.exports = { DEFAULT_VENDOR_MODELS, modelArgsFor, classifyTier, normalizeTier };
