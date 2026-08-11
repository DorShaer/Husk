'use strict';

const MODEL_FLAGS = Object.freeze({
  claude: '--model',
  copilot: '--model',
  codex: '--model',
  aider: '--model',
  gemini: '-m',
  'kiro-cli': '--model',
});

const PROVIDER_LABELS = Object.freeze({
  claude: 'Claude Code',
  copilot: 'GitHub Copilot',
  codex: 'OpenAI Codex',
  aider: 'Aider',
  gemini: 'Gemini',
  'kiro-cli': 'Kiro CLI',
});

const FALLBACK_MODEL_CATALOGS = Object.freeze({
  claude: [
    ['opus', 'Opus 5'],
    ['opus[1m]', 'Opus 5 With 1M Context'],
    ['fable', 'Fable 5'],
    ['sonnet', 'Sonnet 5'],
    ['haiku', 'Haiku 4.5'],
  ],
  copilot: [
    ['claude-sonnet-5', 'Claude Sonnet 5'],
    ['claude-sonnet-4.6', 'Claude Sonnet 4.6'],
    ['claude-sonnet-4.5', 'Claude Sonnet 4.5'],
    ['claude-haiku-4.5', 'Claude Haiku 4.5'],
    ['claude-fable-5', 'Claude Fable 5'],
    ['claude-opus-4.8', 'Claude Opus 4.8'],
    ['claude-opus-4.8-fast', 'Claude Opus 4.8 (fast mode)'],
    ['claude-opus-4.7', 'Claude Opus 4.7'],
    ['claude-opus-4.6', 'Claude Opus 4.6'],
    ['claude-opus-4.5', 'Claude Opus 4.5'],
    ['gpt-5.5', 'GPT-5.5'],
    ['gpt-5.4', 'GPT-5.4'],
    ['gpt-5.3-codex', 'GPT-5.3-Codex'],
    ['gpt-5.4-mini', 'GPT-5.4 mini'],
    ['gpt-5-mini', 'GPT-5 mini'],
    ['gemini-3.1-pro', 'Gemini 3.1 Pro'],
    ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
    ['kimi-k2.7-code', 'Kimi K2.7 Code'],
    ['mai-code-1-flash', 'MAI-Code-1-Flash'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['gpt-5.6-terra', 'GPT-5.6 Terra'],
    ['gpt-5.6-luna', 'GPT-5.6 Luna'],
  ],
  codex: [
    ['gpt-5.3-codex', 'GPT-5.3-Codex'],
    ['gpt-5.5', 'GPT-5.5'],
    ['gpt-5.4', 'GPT-5.4'],
    ['gpt-5.4-mini', 'GPT-5.4 mini'],
    ['gpt-5-mini', 'GPT-5 mini'],
  ],
  gemini: [
    ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro'],
    ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
    ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
  ],
  aider: [
    ['sonnet', 'Claude Sonnet (aider alias)'],
    ['opus', 'Claude Opus (aider alias)'],
    ['haiku', 'Claude Haiku (aider alias)'],
    ['flash', 'Gemini Flash (aider alias)'],
    ['4o', 'GPT-4o (aider alias)'],
    ['r1', 'DeepSeek R1 (aider alias)'],
    ['deepseek', 'DeepSeek Chat (aider alias)'],
  ],
  'kiro-cli': [],
});

function modelFlagFor(vendor) {
  return MODEL_FLAGS[String(vendor || '').toLowerCase()] || null;
}

function providerLabel(vendor) {
  const v = String(vendor || '').toLowerCase();
  return PROVIDER_LABELS[v] || (v ? v[0].toUpperCase() + v.slice(1) : 'Agent');
}

function fallbackModelsFor(vendor) {
  return uniqueModels((FALLBACK_MODEL_CATALOGS[String(vendor || '').toLowerCase()] || [])
    .map(([value, label]) => ({ value, label })));
}

function stripAnsi(input) {
  return String(input || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;]*[Hf]/g, '\n')
    .replace(/\x1b\[[0-9;]*[ABCDGJK]/g, '\n')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function cleanLine(line) {
  return String(line || '')
    .replace(/[│┃║╎╏]/g, ' ')
    .replace(/[┌┐└┘├┤┬┴┼─━═╭╮╰╯]/g, ' ')
    .replace(/^[\s>*›❯➜→•·●○◉◌◦✓✔☑\-\[\]()/]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromId(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const last = raw.split('/').pop();
  return last
    .split(/[-_\s]+/)
    .map((part) => {
      if (/^(gpt|ai|llm|api)$/i.test(part)) return part.toUpperCase();
      if (/^\d/.test(part)) return part;
      return part ? part[0].toUpperCase() + part.slice(1) : part;
    })
    .join(' ')
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bAi\b/g, 'AI');
}

// Every picker row reads "<Name> · <what it is for>". Normalize the name half
// of a long-context row and keep the description after the separator so the
// row matches its siblings in the dropdown.
function longContextLabel(description, family) {
  const parts = String(description || '').split('·');
  const name = parts[0]
    .replace(/\(1m context\)/ig, '')
    .replace(/\bwith\s+1m\s+context\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim() || titleFromId(family);
  const rest = parts.slice(1).join('·').replace(/\s+/g, ' ').trim();
  const named = `${name} With 1M Context`;
  return rest ? `${named} · ${rest}` : named;
}

function cleanLabel(label) {
  return String(label || '')
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/\s+-\s+/g, ': ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeModelId(value) {
  let id = String(value || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[),.;:]+$/g, '');
  if (/^(GPT|CLAUDE|GEMINI|CODEX|OPENAI|ANTHROPIC|GOOGLE)[A-Z0-9._/:+-]*$/i.test(id)) {
    id = id.toLowerCase();
  }
  if (!id || id.length > 90) return '';
  if (!/[A-Za-z0-9]/.test(id)) return '';
  return id;
}

function labelBefore(text, index) {
  const prefix = String(text || '').slice(Math.max(0, index - 90), index)
    .replace(/.*(?:\n|^)/s, '')
    .replace(/^.*\)\s*/, '')
    .replace(/\b(select|choose)\s+a\s+model\b/ig, '')
    .replace(/[|•·]+/g, ' ')
    .replace(/\b(?:current|selected|default)\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  return prefix.replace(/^[\s>*›❯➜→•·●○◉◌◦✓✔☑\-\[\]()/]+/, '').trim();
}

// Vendor-word model ids, optionally carrying one "provider/" prefix. Matches
// start at the vendor word and grow leftward over a plain "token/" when one
// directly precedes them, which keeps the core regex flat.
const MODEL_CORE_RE = /\b(?:gpt|claude|gemini|codex|o[1-9]|llama|mistral|mixtral|qwen|deepseek|grok|xai|openai|anthropic|google)[A-Za-z0-9._/:+-]*/ig;
const MODEL_PREFIX_RE = /([A-Za-z0-9]+\/)$/;
function directModelMatches(text) {
  const out = [];
  const src = String(text || '');
  for (const m of src.matchAll(MODEL_CORE_RE)) {
    let start = m.index;
    let value = m[0];
    const pre = src.slice(Math.max(0, start - 25), start).match(MODEL_PREFIX_RE);
    if (pre) { value = pre[1] + value; start -= pre[1].length; }
    if (value.length > 90) continue;
    out.push({ value, index: start, length: value.length });
  }
  return out;
}

function allModelCandidatesFromText(text, vendor) {
  const items = [];
  const src = String(text || '');

  for (const m of src.matchAll(/\(([A-Za-z0-9][A-Za-z0-9._/:+-]{1,88})\)/g)) {
    const value = normalizeModelId(m[1]);
    if (!value || !looksLikeModelId(value, vendor)) continue;
    items.push({ value, label: labelBefore(src, m.index) || titleFromId(value) });
  }

  for (const m of src.matchAll(/[`'"]([A-Za-z0-9][A-Za-z0-9._/:+-]{1,88})[`'"]/g)) {
    const value = normalizeModelId(m[1]);
    if (!value || !looksLikeModelId(value, vendor)) continue;
    items.push({ value, label: labelBefore(src, m.index) || titleFromId(value) });
  }

  for (const d of directModelMatches(src)) {
    const suffix = src.slice(d.index + d.length, d.index + d.length + 8);
    if (/^\s+mini\b/i.test(suffix)) continue;
    const value = normalizeModelId(d.value);
    if (!value || !looksLikeModelId(value, vendor)) continue;
    items.push({ value, label: titleFromId(value), source: 'direct' });
  }

  return uniqueModels(items);
}

function modelIdFromDisplayLabel(label, vendor) {
  const v = String(vendor || '').toLowerCase();
  let s = String(label || '')
    .replace(/\bcurrent\b/ig, '')
    .replace(/\bpreview\b/ig, '')
    .replace(/\([^)]*(?:context|current|preview)[^)]*\)/ig, '')
    .replace(/\((fast mode)\)/ig, ' fast')
    .replace(/[\u2014\u2013|\u00b7]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /^auto$/i.test(s)) return '';
  if (!/\b(gpt|claude|gemini|kimi|mai|codex|o[1-9]|llama|mistral|mixtral|qwen|deepseek|grok)\b/i.test(s)) return '';
  const id = normalizeModelId(s.toLowerCase().replace(/[^a-z0-9.+/]+/g, '-').replace(/^-+|-+$/g, ''));
  return looksLikeModelId(id, v) || /^(kimi|mai)-/.test(id) ? id : '';
}

function modelRowsFromPicker(text, vendor) {
  const out = [];
  let inPicker = false;
  for (const raw of String(text || '').split('\n')) {
    const line = cleanLine(raw);
    if (!line) continue;
    if (/^Model\b.*\bReasoning\b/i.test(line)) { inPicker = true; continue; }
    if (!inPicker) continue;
    if (/^Search\b/i.test(line)) break;
    if (/^(Start of Prompt|Plan:|Session:|Loading:|Tip:|Home:|Copilot\b|Check for|MCP server|[0-9]+\s*s,|↑|↓|default|low|medium|high|extra high|max|minimal|none)\b/i.test(line)) continue;
    if (/^[^:\s]+:.*\b(Session|Plan):/i.test(line)) continue;
    if (/^[\s\-\u2014\u2013\u2500]+$/.test(line)) continue;
    const id = modelIdFromDisplayLabel(line, vendor);
    if (!id) continue;
    out.push({
      value: id,
      label: cleanLabel(line.replace(/\s*\(current\)\s*/ig, '')),
    });
  }
  return uniqueModels(out);
}

function modelCandidateFromLine(line, vendor) {
  const l = cleanLine(line);
  if (!l) return null;
  if (/^(usage|options|commands|arguments|positionals|examples?|run |press |enter |esc\b|select a model|choose a model|available models?|model settings)$/i.test(l)) return null;
  if (/^(--|-)[A-Za-z]/.test(l)) return null;
  if (isCliStatusLine(l)) return null;
  if (vendor === 'claude' && /^\d+\.\s*Default\b/i.test(l)) return null;

  if (vendor === 'claude') {
    // Numbered picker rows: "1. (selected) opus - description". Parsed
    // stepwise, one flat match per part.
    const rowNum = l.match(/^\d+\./);
    if (rowNum) {
      let rest = l.slice(rowNum[0].length).trim();
      const tag = rest.match(/^\((?:selected|current|recommended)\)/i);
      if (tag) rest = rest.slice(tag[0].length).trim();
      const fam = rest.match(/^(opus|fable|sonnet|haiku)\b/i);
      if (fam) {
        let value = fam[1].toLowerCase();
        rest = rest.slice(fam[0].length).trim();
        // The long-context row qualifies the family name rather than naming a
        // separate one: "Opus (1M context)". The tier belongs to the id the
        // CLI accepts, so it moves into the value.
        const tier = rest.match(/^\(1m context\)/i);
        if (tier) { value += '[1m]'; rest = rest.slice(tier[0].length).trim(); }
        let label = rest.replace(/^[-\u2014\u2013]/, '').trim().slice(0, 160);
        if (tier) label = longContextLabel(label, fam[1]);
        return { value, label: cleanLabel(label || titleFromId(value)) };
      }
    }
  }

  if (vendor === 'aider') {
    // aider --list-models prints one provider-route id per line
    // (anthropic/claude-sonnet-4-5, openrouter/z-ai/glm-4.6). A whole line is
    // a provider route when every /-separated segment is a plain token.
    const segs = l.length <= 90 && l.includes('/') ? l.split('/') : null;
    const route = segs && segs.length >= 2 && segs.length <= 7
      && /^[A-Za-z0-9]/.test(l)
      && segs.every((p) => /^[A-Za-z0-9._:+-]+$/.test(p))
      ? [l, l] : null;
    if (route) {
      const value = normalizeModelId(route[1]);
      if (value && !/\.(json|jsonc|ya?ml|md|txt|lock|toml)$/i.test(value)) {
        return { value, label: titleFromId(value) };
      }
    }
  }

  const paren = l.match(/\(([A-Za-z0-9][A-Za-z0-9._/:+-]{1,88})\)/);
  const quoted = l.match(/[`'"]([A-Za-z0-9][A-Za-z0-9._/:+-]{1,88})[`'"]/);
  const preferred = paren || quoted;
  if (preferred) {
    const value = normalizeModelId(preferred[1]);
    if (value && looksLikeModelId(value, vendor)) {
      const label = l.replace(preferred[0], '').replace(/\s+/g, ' ').trim() || titleFromId(value);
      return { value, label: cleanLabel(label) };
    }
  }

  for (const direct of directModelMatches(l)) {
    const suffix = l.slice(direct.index + direct.length, direct.index + direct.length + 8);
    if (/^\s+mini\b/i.test(suffix)) continue;
    const value = normalizeModelId(direct.value);
    if (value && looksLikeModelId(value, vendor)) {
      const label = l === value ? titleFromId(value) : l.replace(/\s*\[(?:current|default|selected)\]\s*/i, '').trim();
      return { value, label: cleanLabel(label || titleFromId(value)) };
    }
  }
  return null;
}

function isCliStatusLine(line) {
  const l = String(line || '');
  return /\bSession:\s*[\d,]+\s*AIC used\b/i.test(l)
    || /\bPlan:\s*/i.test(l)
    || /\bStart of Prompt Indicator\b/i.test(l)
    || /\bLoading:\s*/i.test(l)
    || /\bTip:\s*/i.test(l)
    || /\bmanual mode\b/i.test(l)
    || /\beffort:\s*/i.test(l)
    || /\bPAI\s*[|:]/i.test(l)
    || /\bcontext\s*\(\d+%?\)/i.test(l);
}

function isModelValueUsable(value, vendor) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 90) return false;
  if (/\s/.test(raw)) return false;
  if (/not logged in|use \/login|authenticate|plan:|session:|aic used|context\b/i.test(raw)) return false;
  if (isCliStatusLine(raw)) return false;
  const normalized = normalizeModelId(raw);
  if (!normalized || normalized !== raw.replace(/[),.;:]+$/g, '')) return false;
  if (looksLikeModelId(normalized, vendor)
    || /^(opus|fable|sonnet|haiku|opusplan)(\[1m\])?$/i.test(normalized)
    || /^(kimi|mai)-/i.test(normalized)) return true;
  // aider routes to arbitrary providers (openrouter/x/y, bare aliases like
  // flash or r1), so a saved aider value keeps its own shape.
  return String(vendor || '').toLowerCase() === 'aider'
    && /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/.test(normalized);
}

function looksLikeModelId(id, vendor) {
  const v = String(vendor || '').toLowerCase();
  const x = String(id || '').toLowerCase();
  if (!x || x === 'model' || x === 'models' || x === 'auto') return false;
  if (/^(gpt|claude|gemini|codex|llama|mistral|mixtral|qwen|deepseek|grok|xai|openai|anthropic|google)$/.test(x)) return false;
  // Help text and config references carry vendor-prefixed tokens that are not
  // models (claude/settings.json, claude-api). File paths and doc-ish
  // suffixes drop out before the vendor-prefix acceptance below.
  if (/\.(json|jsonc|ya?ml|md|txt|log|lock|toml|ini|cfg|conf|sh|bash|zsh|mjs|cjs|js|ts|tsx|jsx|py|rb|go|rs|css|html)$/.test(x)) return false;
  if (/(^|[-./_])(api|sdk|cli|docs?|settings|config|readme|help)$/.test(x)) return false;
  if (v === 'claude') {
    // The claude CLI accepts tier aliases and claude-* ids only; anything
    // else scraped from its TUI is narration. Either form may carry the
    // long-context suffix, as in opus[1m].
    if (/^(haiku|sonnet|opus|fable|opusplan)(\[1m\])?$/.test(x)) return true;
    return /^claude-[a-z0-9][a-z0-9.-]*(\[1m\])?$/.test(x);
  }
  // One optional "provider/" prefix, stripped before the vendor-word check so
  // the regex stays flat.
  const body = /^[a-z0-9]+\//.test(x) ? x.slice(x.indexOf('/') + 1) : x;
  return /^(?:gpt|claude|gemini|codex|o[1-9]|llama|mistral|mixtral|qwen|deepseek|grok|xai|openai|anthropic|google)/.test(body);
}

function uniqueModels(items) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const value = normalizeModelId(item && item.value);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      value,
      label: cleanLabel((item && item.label) || titleFromId(value)) || value,
      source: item && item.source,
    });
  }
  return out.map(({ value, label }) => ({ value, label }));
}

function parseModelCatalog(text, vendor) {
  const clean = stripAnsi(text);
  const models = [...modelRowsFromPicker(clean, vendor)];
  if (models.length) return uniqueModels(models);
  for (const raw of clean.split('\n')) {
    const rowItems = allModelCandidatesFromText(raw, vendor);
    if (rowItems.length > 1) {
      models.push(...rowItems);
      continue;
    }
    const item = modelCandidateFromLine(raw, vendor);
    if (item) models.push(item);
  }
  return uniqueModels(models);
}

module.exports = {
  MODEL_FLAGS,
  PROVIDER_LABELS,
  FALLBACK_MODEL_CATALOGS,
  fallbackModelsFor,
  modelFlagFor,
  providerLabel,
  parseModelCatalog,
  stripAnsi,
  titleFromId,
  uniqueModels,
  allModelCandidatesFromText,
  modelIdFromDisplayLabel,
  modelRowsFromPicker,
  isCliStatusLine,
  isModelValueUsable,
};
