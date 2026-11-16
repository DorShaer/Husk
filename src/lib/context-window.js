'use strict';

// Base context-window capacity (tokens) per model family, across the agents
// Husk can launch. Matched in order against the id with its tier suffix
// stripped; null for an unknown family. Current Claude models (Fable, Mythos,
// Opus 4.6+, Sonnet 4.6+, Haiku 5+) are 1M; the older ones listed first are
// 200K, with their 1M tier handled by the "[1m]" suffix in resolveContextWindow.
// OpenAI Codex docs (GPT-5.x 400K, GPT-4.1 1M, GPT-4o 128K, o-series 200K);
// Google Gemini docs (2.x/3 = 1M); GitHub Copilot CLI docs (128K default).
const MODEL_CONTEXT_WINDOWS = [
  [/^claude-3/, 200000],
  [/^claude-(opus|sonnet|haiku)-4(-[015])?(-\d{8})?$/, 200000],
  [/^claude-/, 1000000],
  [/^gpt-5/, 400000],
  [/^gpt-4\.1/, 1000000],
  [/^gpt-4/, 128000],
  [/^o[1-9]/, 200000],
  [/codex/, 192000],
  [/^gemini-/, 1000000],
  [/copilot/, 128000],
];

function baseContextWindow(model) {
  const m = String(model || '').toLowerCase();
  for (const [re, size] of MODEL_CONTEXT_WINDOWS) if (re.test(m)) return size;
  return null;
}

// Occupancy can never exceed the real window, so usage past the table's size
// proves the table is stale for this model; widen instead of showing over 100%.
function fitWindow(size, used) {
  const u = Number(used) || 0;
  return u > size ? Math.max(1000000, u) : size;
}

module.exports = { MODEL_CONTEXT_WINDOWS, baseContextWindow, fitWindow };
