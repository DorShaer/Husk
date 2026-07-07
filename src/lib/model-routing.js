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
const DEFAULT_VENDOR_MODELS = Object.freeze({
  // claude accepts stable aliases the CLI resolves to the current version.
  claude:  { flag: '--model', cheap: 'haiku', smart: 'opus' },
  gemini:  { flag: '-m', cheap: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
  // codex / aider / copilot: model choice is bound to the account or a config
  // file, and a wrong id fails the CLI, so route only when the user opts in
  // with overrides. null = leave the CLI's own model.
  codex: null,
  aider: null,
  copilot: null,
});

// Return the argv fragment that selects `tier`'s model for this CLI, or []
// when the vendor has no mapping (leave its default). overrides is a
// per-vendor table merged over the defaults.
function modelArgsFor(agentBaseName, tier, overrides = {}) {
  const base = String(agentBaseName || '').toLowerCase();
  const entry = Object.prototype.hasOwnProperty.call(overrides, base)
    ? overrides[base]
    : DEFAULT_VENDOR_MODELS[base];
  if (!entry || !entry.flag) return [];
  const model = tier === 'cheap' ? entry.cheap : entry.smart;
  if (!model || typeof model !== 'string') return [];
  return [entry.flag, model];
}

// Classify a goal into a model tier. Conservative by design: only route DOWN
// to cheap on clearly mechanical work, default smart so a complex task never
// lands on a weak model (routing wrong toward cheap costs quality; routing
// wrong toward smart only costs tokens).
const CHEAP_RE = new RegExp(
  '\\b(bump|upgrade|update)\\b[^.]*\\b(dep|deps|dependenc\\w*|version\\w*|package\\w*)'
  + '|\\b(re)?format\\b|\\blint\\b|prettier|eslint --fix'
  + '|\\brename\\b|\\btypo\\b|sort imports|organize imports'
  + '|find (all )?(the )?(todo|fixme)|list (all )?|inventory of'
  + '|add (a )?(comment|docstring|jsdoc)|changelog', 'i');

function classifyTier(goal) {
  return CHEAP_RE.test(String(goal || '')) ? 'cheap' : 'smart';
}

// Normalize a tier value from any source (planner output, config) to a valid
// tier, defaulting smart.
function normalizeTier(t) {
  return t === 'cheap' ? 'cheap' : 'smart';
}

module.exports = { DEFAULT_VENDOR_MODELS, modelArgsFor, classifyTier, normalizeTier };
