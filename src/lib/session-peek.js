'use strict';

// The peek pane's short feed built from normalized chat events: what was asked,
// what the agent said, which tools it reached for.

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
    if (ev.type === 'session' && ev.model) model = String(ev.model);
    if (ev.type === 'text') {
      if (!streaming) { streaming = { kind: 'assistant', raw: '', ts }; entries.push(streaming); }
      streaming.raw += String(ev.text || '');
      streaming.text = clip(streaming.raw, 240);
      continue;
    }
    streaming = null;
    if (ev.type === 'user' && String(ev.text || '').trim()) entries.push({ kind: 'user', text: clip(ev.text, 200), ts });
    else if (ev.type === 'text_final' && String(ev.text || '').trim()) entries.push({ kind: 'assistant', text: clip(ev.text, 240), ts });
    // Tool updates repeat the id without a title; only the call itself is a line.
    else if (ev.type === 'tool' && ev.title) entries.push({ kind: 'tool', tool: clip(ev.title, 40), text: clip(ev.detail, 80), ts });
  }
  const out = entries.filter((e) => e.text || e.kind === 'tool').slice(-max).map(({ raw, ...e }) => e);
  return { entries: out, model, empty: out.length === 0 };
}

module.exports = { peekFromEvents };
