'use strict';

// The peek pane's short feed built from normalized chat events: what was asked,
// what the agent said, which tools it reached for.

const { withoutContext } = require('./brain');
const { modelValue } = require('./chat-events');

function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function peekFromEvents(events, max = 24) {
  const entries = [];
  let model = '';
  let streaming = null;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    const ts = typeof ev.at === 'number' ? ev.at : 0;
    if (ev.type === 'session' && modelValue(ev.model)) model = String(ev.model);
    if (ev.type === 'text') {
      if (!streaming) { streaming = { kind: 'assistant', raw: '', ts }; entries.push(streaming); }
      streaming.raw += String(ev.text || '');
      streaming.text = clip(streaming.raw, 240);
      continue;
    }
    streaming = null;
    if (ev.type === 'user' && withoutContext(ev.text).trim()) entries.push({ kind: 'user', text: clip(withoutContext(ev.text), 200), ts });
    else if (ev.type === 'text_final' && String(ev.text || '').trim()) entries.push({ kind: 'assistant', text: clip(ev.text, 240), ts });
    // Tool updates repeat the id without a title; only the call itself is a line.
    else if (ev.type === 'tool' && ev.title) entries.push({ kind: 'tool', tool: clip(ev.title, 40), text: clip(ev.detail, 80), ts });
  }
  const out = entries.filter((e) => e.text || e.kind === 'tool').slice(-max).map(({ raw, ...e }) => e);
  return { entries: out, model, empty: out.length === 0 };
}

// The same feed read off a claude transcript tail: one JSON object per line.
function peekFromTranscript(text, max = 24) {
  const entries = [];
  let model = '';
  // One-line summary of a tool call: the argument a human would use to name
  // it. Paths keep their tail, the interesting part, rather than the noise
  // of a temp prefix.
  const toolArg = (input) => {
    if (!input || typeof input !== 'object') return '';
    for (const k of ['file_path', 'path']) {
      if (typeof input[k] === 'string' && input[k]) {
        const segs = input[k].split(/[\\/]/).filter(Boolean);
        return clip(segs.slice(-2).join('/'), 72);
      }
    }
    const keys = ['command', 'pattern', 'query', 'url', 'description', 'prompt'];
    for (const k of keys) if (typeof input[k] === 'string' && input[k]) return clip(input[k], 80);
    return '';
  };
  // Tool calls with no result yet, by id; the newest one left is what a waiting agent waits on.
  const open = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line || line.length > 2 * 1024 * 1024) continue;
    let o = null;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || typeof o !== 'object') continue;
    const ts = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (Array.isArray(c)) for (const part of c) if (part && part.type === 'tool_result') open.delete(part.tool_use_id);
      // A new prompt starts a new turn; a call left open before it was interrupted, not waiting.
      if ((typeof c === 'string' && c.trim()) || (Array.isArray(c) && c.some((p) => p && p.type === 'text'))) open.clear();
      if (typeof c === 'string' && withoutContext(c).trim()) {
        entries.push({ kind: 'user', text: clip(withoutContext(c), 200), ts });
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (part && part.type === 'text' && withoutContext(part.text).trim()) {
            entries.push({ kind: 'user', text: clip(withoutContext(part.text), 200), ts });
            break;
          }
        }
      }
    } else if (o.type === 'assistant' && o.message) {
      if (modelValue(o.message.model)) model = modelValue(o.message.model);
      const c = o.message.content;
      if (!Array.isArray(c)) continue;
      for (const part of c) {
        if (!part) continue;
        if (part.type === 'text' && String(part.text || '').trim()) {
          entries.push({ kind: 'assistant', text: clip(part.text, 240), ts });
        } else if (part.type === 'tool_use') {
          entries.push({ kind: 'tool', tool: clip(part.name, 40), text: toolArg(part.input), ts });
          const q = part.input && Array.isArray(part.input.questions) && part.input.questions[0];
          if (part.id) open.set(part.id, { tool: clip(part.name, 40), text: toolArg(part.input), question: q && q.question ? clip(q.question, 240) : '' });
        }
      }
    }
  }
  const pending = open.size ? [...open.values()].pop() : null;
  return { entries: max ? entries.slice(-max) : entries, model, empty: entries.length === 0, pending };
}

// What the branch canvas draws beside an agent: when each tool call landed,
// the newest activity row of its own, and the model. `since` is where the read began when
// the transcript was longer than the tail, so nothing before it is claimed.
function pulseFromTranscript(text, { truncated = false, keepMs = 2 * 3600 * 1000, now = Date.now() } = {}) {
  const { entries, model, pending } = peekFromTranscript(text, 0);
  const calls = entries.filter((e) => e.kind === 'tool' && e.ts && e.ts >= now - keepMs).map((e) => e.ts).slice(-600);
  // What the agent did last; a prompt it was given is not something it is doing.
  const last = entries.filter((e) => e.kind !== 'user').pop() || null;
  const first = entries.find((e) => e.ts);
  return {
    calls,
    last: last ? { kind: last.kind, tool: last.tool || '', text: clip(last.text, 120), ts: last.ts } : null,
    model,
    since: truncated && first ? first.ts : 0,
    pending,
    said: (entries.filter((e) => e.kind === 'assistant').pop() || {}).text || '',
  };
}

module.exports = { peekFromEvents, peekFromTranscript, pulseFromTranscript };
