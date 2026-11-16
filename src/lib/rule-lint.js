'use strict';

// Enforced Brain rules: the ones a string transform can keep, so they never
// ride the prompt and never depend on the model remembering. A rule is
// enforced when its node carries `check: { builtin, params }`; the agent's
// output is rewritten on the way to the chat view instead.

const str = (v) => (v === null || v === undefined ? '' : String(v));
const TERM_MAX = 80;

const WORD = '[\\p{L}\\p{N}_]';
const EMOJI = '(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)(?:\\p{Emoji_Modifier}|\\uFE0F|\\u200D\\p{Extended_Pictographic}\\uFE0F?)*';
const EMOJI_RUN = new RegExp(`([ \\t]*)(${EMOJI}(?:[ \\t]*${EMOJI})*)([ \\t]*)`, 'gu');
// Characters that continue the emoji before them, so a chunk is never cut ahead of one.
const JOINER = /^(?:\u200D|\uFE0F|\u20E3|\p{Emoji_Modifier})$/u;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termRe(p) {
  return new RegExp(`(?<!${WORD})${escapeRe(p.term)}(?!${WORD})`, p.caseSensitive ? 'gu' : 'giu');
}

// Each builtin: its fields, whether it rewrites code too, how many trailing
// characters a stream must hold back, and the rewrite of one prose or code run.
// `before` and `after` are the characters around the run, '' at a stream edge.
const BUILTINS = {
  'no-em-dash': {
    label: 'No em dashes',
    inCode: () => true,
    hold: () => 0,
    rewrite: (s) => s.replace(/\u2014/g, '-'),
  },
  'replace-term': {
    label: 'Replace a term',
    inCode: (p) => !!p.inCode,
    // The term, plus one character to know the word ended.
    hold: (p) => p.term.length,
    re: termRe,
    rewrite: (s, before, after, p) => {
      const full = before + s + after;
      const end = before.length + s.length;
      let out = '';
      let last = before.length;
      for (const m of full.matchAll(termRe(p))) {
        if (m.index < before.length || m.index + m[0].length > end) continue;
        out += full.slice(last, m.index) + p.replacement;
        last = m.index + m[0].length;
      }
      return out + full.slice(last, end);
    },
  },
  'no-emoji': {
    label: 'No emoji',
    inCode: () => false,
    hold: () => 1,
    // An emoji goes with the space beside it; between two words one space stays.
    rewrite: (s, before, after) => s.replace(EMOJI_RUN, (m, a, _e, b, off) => {
      const prevCh = off ? s[off - 1] : before;
      const nextCh = off + m.length < s.length ? s[off + m.length] : after;
      const edge = prevCh === '' || prevCh === '\n' || nextCh === '' || nextCh === '\n';
      return !edge && a && b ? ' ' : '';
    }),
  },
};

// A check as stored on a rule node, validated. -> { ok, check } | { ok: false, error }
function normalizeCheck(check) {
  const id = str(check && check.builtin);
  if (!BUILTINS[id]) return { ok: false, error: 'unknown enforced rule' };
  if (id !== 'replace-term') return { ok: true, check: { builtin: id, params: {} } };
  const p = (check && check.params) || {};
  const term = str(p.term).trim();
  const replacement = str(p.replacement);
  if (!term) return { ok: false, error: 'name the term to replace' };
  if (term.length > TERM_MAX || replacement.length > TERM_MAX) return { ok: false, error: `a term is at most ${TERM_MAX} characters` };
  return { ok: true, check: { builtin: id, params: { term, replacement, caseSensitive: !!p.caseSensitive, inCode: !!p.inCode } } };
}

// What an enforced rule does, as one line a person reads.
function describe(check) {
  const id = check && check.builtin;
  const p = (check && check.params) || {};
  if (id === 'no-em-dash') return 'No em dashes: replaced with a hyphen';
  if (id === 'no-emoji') return 'No emoji in prose';
  if (id === 'replace-term') return `Replace "${p.term}" with "${p.replacement}"${p.inCode ? ', also inside code' : ''}`;
  return '';
}

// A typed rule that looks like a builtin: the check to offer, or null. Never applied by itself.
function detect(text) {
  const raw = str(text);
  const t = raw.toLowerCase();
  if (t.includes('em dash') || t.includes('em-dash') || t.includes('\u2014')) return { builtin: 'no-em-dash', params: {} };
  if (/\bno emojis?\b|\bemojis?\b.*\b(never|avoid|don'?t|no)\b|\b(never|avoid|don'?t)\b.*\bemojis?\b/.test(t)) return { builtin: 'no-emoji', params: {} };
  const m = raw.match(/^\s*(?:say|use|write)\s+["'\u201C](.+?)["'\u201D]\s+(?:instead of|not)\s+["'\u201C](.+?)["'\u201D]\s*\.?\s*$/i);
  if (m) { const r = normalizeCheck({ builtin: 'replace-term', params: { term: m[2], replacement: m[1] } }); return r.ok ? r.check : null; }
  return null;
}

// The builtin a rule node enforces, or null when it is asked of the agent.
function resolve(rule) {
  const r = rule && rule.check ? normalizeCheck(rule.check) : null;
  if (!r || !r.ok) return null;
  const b = BUILTINS[r.check.builtin];
  const p = r.check.params;
  return { id: r.check.builtin, inCode: b.inCode(p), hold: b.hold(p), re: b.re ? () => b.re(p) : null, rewrite: (s, before, after) => b.rewrite(s, before, after, p) };
}

const isMechanical = (rule) => resolve(rule) !== null;

// Splits text into prose and code runs. Three or more backticks open and close
// a fence; one or two open and close inline code, which also ends at a line break.
function splitCode(text, st) {
  const segs = [];
  let i = 0;
  let { fence, inline } = st;
  const cut = (end, code) => { if (end > i) segs.push({ at: i, s: text.slice(i, end), code }); i = end; };
  for (const m of text.matchAll(/`+|\n/g)) {
    if (m[0] === '\n') { if (inline && !fence) { cut(m.index, true); inline = false; } continue; }
    const end = m.index + m[0].length;
    if (fence) { if (m[0].length >= 3) { cut(end, true); fence = false; } continue; }
    if (m[0].length >= 3) { cut(m.index, inline); inline = false; fence = true; continue; }
    if (inline) { cut(end, true); inline = false; } else { cut(m.index, false); inline = true; }
  }
  cut(text.length, fence || inline);
  return { segs, st: { fence, inline } };
}

// One per streamed block. push() returns what is safe to show now and keeps
// back a tail that could still grow into a match; final releases everything.
function createStreamFilter() {
  let held = '';
  let prev = '';
  let st = { fence: false, inline: false };
  function push(chunk, rules, final = false) {
    const active = (rules || []).map(resolve).filter(Boolean);
    const s = held + str(chunk);
    let cut = s.length;
    if (!final) {
      const codeAware = active.some((r) => !r.inCode);
      const emoji = active.some((r) => r.id === 'no-emoji');
      cut = Math.max(0, s.length - Math.max(0, ...active.map((r) => r.hold)));
      const unsafe = (i) => (i < s.length && /[\udc00-\udfff]/.test(s[i]))
        || (emoji && ((i < s.length && JOINER.test(String.fromCodePoint(s.codePointAt(i)))) || /[\u200D \t]/.test(str(s[i - 1]))))
        || (codeAware && s[i - 1] === '`');
      while (cut > 0 && unsafe(cut)) cut -= 1;
      for (const r of active) {
        if (!r.re) continue;
        for (const m of (prev + s).matchAll(r.re())) {
          const a = m.index - prev.length;
          if (a >= 0 && a < cut && a + m[0].length > cut) cut = a;
        }
      }
    }
    const region = s.slice(0, cut);
    const after = final ? '' : str(s[cut]);
    held = s.slice(cut);
    const split = splitCode(region, st);
    let out = '';
    for (const g of split.segs) {
      const before = g.at ? region[g.at - 1] : prev;
      const end = g.at + g.s.length;
      const next = end < region.length ? region[end] : after;
      let t = g.s;
      for (const r of active) if (!g.code || r.inCode) t = r.rewrite(t, before, next);
      out += t;
    }
    if (final) { held = ''; prev = ''; st = { fence: false, inline: false }; } else {
      st = split.st;
      if (region) prev = region[region.length - 1];
    }
    return out;
  }
  return { push };
}

// Rewrites a whole text against every enforced rule in the list. Pure.
function applyMechanical(text, rules) {
  return createStreamFilter().push(text, rules, true);
}

module.exports = { BUILTINS, normalizeCheck, describe, detect, resolve, isMechanical, applyMechanical, createStreamFilter, splitCode };
