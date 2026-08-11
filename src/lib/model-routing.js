'use strict';

// Cross-vendor model routing: pick a cheap or a smart model per task and
// translate that choice into the flag each CLI actually accepts. Mechanical
// work (bump deps, format, find TODOs) should not burn a frontier model;
// hard work should not get a weak one.
//
// Two tiers per vendor. Only claude ships model-name defaults, because its
// --model aliases (haiku, opus) are documented-stable. Every other CLI knows
// its flag but ships null names: a wrong model id fails the whole run, which
// is worse than not routing, so those stay unrouted until the UI discovers
// names or the user supplies them. Every default is overridable from settings,
// keyed by the CLI base name, so a user on any CLI version can point the tiers
// at the exact model names their install accepts.
const DEFAULT_VENDOR_MODELS = Object.freeze({
  claude:  { flag: '--model', cheap: 'haiku', smart: 'opus' },
  copilot: { flag: '--model', cheap: null, smart: null },
  gemini:  { flag: '-m', cheap: null, smart: null },
  codex:   { flag: '--model', cheap: null, smart: null },
  aider:   { flag: '--model', cheap: null, smart: null },
  'kiro-cli': { flag: '--model', cheap: null, smart: null },
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
  const clean = model.trim();
  if (!isExplicitModelValueUsable(clean)) return [];
  return [entry.flag, clean];
}

function isExplicitModelValueUsable(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 90) return false;
  if (/\s/.test(raw)) return false;
  if (/not logged in|use \/login|authenticate|plan:|session:|aic used|context\b/i.test(raw)) return false;
  // A saved value that is really a config path or doc token (a residue of
  // older catalog parsing) must never reach the CLI as --model.
  if (/\.(json|jsonc|ya?ml|md|txt|log|lock|toml|ini|cfg|conf|sh|mjs|cjs|js|ts)$/i.test(raw)) return false;
  if (/(^|[-./_])(api|sdk|cli|docs?|settings|config|readme|help)$/i.test(raw)) return false;
  // A trailing [1m] selects the long-context tier and is part of the id the
  // CLI accepts, so it survives the character check rather than failing it.
  return /^[A-Za-z0-9][A-Za-z0-9._:+/-]*(\[1m\])?$/i.test(raw);
}

// Classify a goal into a model tier. Conservative by design: only route DOWN
// to cheap on clearly mechanical work, default smart so a complex task never
// lands on a weak model (routing wrong toward cheap costs quality; routing
// wrong toward smart only costs tokens).
const CHEAP_RE = new RegExp(
  '\\b(bump|upgrade)\\b[^.]*\\b(dep|deps|dependenc\\w*|version\\w*|package\\w*)'
  + '|\\bupdate\\b[^.]*\\b(dep|deps|dependenc\\w*|version\\w*|package\\w*)\\b(?!\\s+injection)'
  + '|\\b(re)?format\\b|\\blint\\b|prettier|eslint --fix'
  + '|\\brename\\b[^.]*\\b(helper|variable|function|class|method|symbol|file|identifier)\\b|\\btypo\\b|sort imports|organize imports'
  + '|\\b(find|list|scan|hunt|locate|collect|gather|catalog|audit|search|grep)\\b[^.]*\\b(todo|fixme)\\b'
  + '|inventory of|add (a )?(comment|docstring|jsdoc)|changelog', 'i');

// The smallest possible task: put a file on disk with literal content. It is not
// "maintenance" in the CHEAP_RE sense, so without its own rule it falls through
// to the smart tier and lands on a frontier model, which is how "write hello123
// into test.txt" costs dollars. The guards keep real engineering out: anything long,
// or naming work that needs judgement, stays on the smart tier, because routing
// wrong toward cheap costs quality and that is the expensive mistake.
const TRIVIAL_VERB_RE = /\b(create|creates|creating|make|makes|add|adds|write|writes|writing|wriute|put|touch|generate)\b/i;
const TRIVIAL_TARGET_RE = /\b(file|\.txt|\.md|\.json|\.csv|\.log|\.yml|\.yaml)\b/i;
const NOT_TRIVIAL_RE = /\b(implement|build|design|refactor|debug|fix|migrat\w*|integrat\w*|test|spec|api|endpoint|component|module|class|function|feature|script|parser|server|schema|migration|auth|deploy|optimi[sz]e|rewrite|port|convert)\b/i;

function isTrivialFileTask(goal) {
  const g = String(goal || '').trim();
  // A trivial task is a short, single instruction. Length is the cheapest proxy
  // for "carries requirements", and a long goal always deserves a capable model.
  if (!g || g.length > 140) return false;
  if (!TRIVIAL_VERB_RE.test(g)) return false;
  if (!TRIVIAL_TARGET_RE.test(g)) return false;
  // Filenames are not requirements. Drop them before looking for the words that
  // mean real work, or a file called test.txt reads as "write tests" and a file
  // called api.json reads as "build an API".
  const withoutFilenames = g.replace(/\b[\w-]+\.(txt|md|json|csv|log|ya?ml|js|ts|jsx|tsx|html|css|sh|py)\b/gi, ' ');
  if (NOT_TRIVIAL_RE.test(withoutFilenames)) return false;
  return true;
}

function classifyTier(goal) {
  const g = String(goal || '');
  if (CHEAP_RE.test(g)) return 'cheap';
  if (isTrivialFileTask(g)) return 'cheap';
  return 'smart';
}

// Normalize a tier value from any source (planner output, config) to a valid
// tier, defaulting smart.
function normalizeTier(t) {
  return t === 'cheap' ? 'cheap' : 'smart';
}

module.exports = { DEFAULT_VENDOR_MODELS, modelArgsFor, classifyTier, normalizeTier, isTrivialFileTask };
