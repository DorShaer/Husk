'use strict';

// Turns an agent's on-disk session log into Husk chat events, so resuming a
// past session in Chat view shows the conversation so far instead of an empty
// thread. Two formats, both sampled from real logs on 2026-10-26:
//   claude   ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl
//            one JSON object per line; `user` / `assistant` lines carry a
//            message with string or block-array content; many other line
//            types (attachment, api-request*, cost-state, queue-operation,
//            file-history-snapshot, last-prompt) are bookkeeping and skipped
//   copilot  ~/.copilot/session-state/<id>/events.jsonl
//            user.message, assistant.message (content + toolRequests),
//            tool.execution_start / tool.execution_complete,
//            permission.requested / permission.completed, assistant.turn_end,
//            session.model_change
// Output uses the vocabulary in chat-events.js and replays through its
// reducer. Pure: no fs here, the caller reads the file.

const { toolDetail, kindForTool } = require('./chat-events');

const MAX_EVENTS = 4000;
const MAX_TEXT = 400000;

function str(v) { return v === null || v === undefined ? '' : String(v); }

// Synthetic prompts the CLI writes for itself (local command echoes, hook
// output, system reminders) start with a tag and are not the user's words.
function isSyntheticPrompt(text) {
  const t = str(text).trimStart();
  return t.startsWith('<local-command') || t.startsWith('<command-') || t.startsWith('<system-reminder') || t.startsWith('<bash-input') || t.startsWith('<bash-stdout') || t.startsWith('<bash-stderr');
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && c.type === 'text' ? str(c.text) : '')).filter(Boolean).join('\n');
}

// Keeps the tail of the conversation within the same bounds the live replay
// log uses, dropping whole events from the front.
function bound(events) {
  let text = 0;
  for (const ev of events) if (ev && ev.text) text += ev.text.length;
  let out = events;
  while (out.length > MAX_EVENTS || (text > MAX_TEXT && out.length > 1)) {
    const dropped = out[0];
    out = out.slice(1);
    if (dropped && dropped.text) text -= dropped.text.length;
  }
  return out;
}

function parseLines(raw) {
  const out = [];
  for (const line of str(raw).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* a torn last line */ }
  }
  return out;
}

// ─── claude ──────────────────────────────────────────────────────────────────

function claudeTranscriptToEvents(raw) {
  const events = [];
  let turnOpen = false;
  let model = null;
  const endTurn = () => { if (turnOpen) { events.push({ type: 'turn_end', stopReason: 'end_turn' }); turnOpen = false; } };
  for (const o of parseLines(raw)) {
    if (!o || typeof o !== 'object') continue;
    if (o.isSidechain || o.isMeta) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const msg = o.message || {};
    const content = msg.content;
    if (o.type === 'user') {
      if (typeof content === 'string') {
        if (isSyntheticPrompt(content) || !content.trim()) continue;
        endTurn();
        events.push({ type: 'user', text: content });
        turnOpen = true;
        continue;
      }
      if (!Array.isArray(content)) continue;
      const texts = content.filter((c) => c && c.type === 'text' && !isSyntheticPrompt(c.text) && str(c.text).trim());
      const results = content.filter((c) => c && c.type === 'tool_result');
      for (const r of results) {
        events.push({ type: 'tool', id: str(r.tool_use_id), status: r.is_error ? 'error' : 'done', output: blockText(r.content) });
      }
      if (texts.length) {
        endTurn();
        events.push({ type: 'user', text: texts.map((c) => str(c.text)).join('\n') });
        turnOpen = true;
      }
      continue;
    }
    // assistant
    if (msg.model && msg.model !== model) { model = str(msg.model); events.push({ type: 'session', model }); }
    if (!Array.isArray(content)) continue;
    if (!turnOpen) { events.push({ type: 'turn_start' }); turnOpen = true; }
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && str(b.text).trim()) events.push({ type: 'text_final', text: str(b.text) });
      else if (b.type === 'thinking' && str(b.thinking).trim()) { events.push({ type: 'thought', text: str(b.thinking) }); events.push({ type: 'block_end' }); }
      else if (b.type === 'tool_use') events.push({ type: 'tool', id: str(b.id), title: str(b.name), kind: kindForTool(b.name), status: 'running', detail: toolDetail(b.name, b.input), input: b.input });
    }
  }
  endTurn();
  return bound(events);
}

// ─── copilot ─────────────────────────────────────────────────────────────────

function copilotEventsToEvents(raw) {
  const events = [];
  let turnOpen = false;
  const endTurn = () => { if (turnOpen) { events.push({ type: 'turn_end', stopReason: 'end_turn' }); turnOpen = false; } };
  for (const o of parseLines(raw)) {
    if (!o || typeof o !== 'object') continue;
    const d = o.data || {};
    switch (o.type) {
      case 'session.model_change':
        if (d.newModel) events.push({ type: 'session', model: str(d.newModel) });
        break;
      case 'user.message':
        if (!str(d.content).trim()) break;
        endTurn();
        events.push({ type: 'user', text: str(d.content) });
        turnOpen = true;
        break;
      case 'assistant.turn_start':
        if (!turnOpen) { events.push({ type: 'turn_start' }); turnOpen = true; }
        break;
      case 'assistant.message': {
        if (!turnOpen) { events.push({ type: 'turn_start' }); turnOpen = true; }
        if (str(d.content).trim()) events.push({ type: 'text_final', text: str(d.content) });
        for (const r of Array.isArray(d.toolRequests) ? d.toolRequests : []) {
          if (!r) continue;
          events.push({ type: 'tool', id: str(r.toolCallId), title: str(r.name), kind: kindForTool(r.name), status: 'running', input: r.arguments, detail: typeof r.arguments === 'string' ? r.arguments.split('\n')[0].slice(0, 160) : toolDetail(r.name, r.arguments) });
        }
        break;
      }
      case 'tool.execution_start':
        events.push({ type: 'tool', id: str(d.toolCallId), title: str(d.toolTitle || d.toolName), kind: kindForTool(d.toolName), status: 'running' });
        break;
      case 'tool.execution_complete': {
        const res = d.result || {};
        events.push({ type: 'tool', id: str(d.toolCallId), status: d.success === false ? 'error' : 'done', output: str(res.content || res.detailedContent || '') });
        break;
      }
      case 'permission.requested': {
        const p = d.permissionRequest || {};
        events.push({
          type: 'permission', requestId: str(d.requestId), toolCallId: p.toolCallId !== undefined ? str(p.toolCallId) : undefined,
          title: str(p.intention || p.kind || 'Permission'), detail: p.fileName ? str(p.fileName) : undefined,
          options: [{ optionId: 'approved', name: 'Approve', kind: 'allow_once' }, { optionId: 'denied', name: 'Deny', kind: 'reject_once' }],
        });
        break;
      }
      case 'permission.completed': {
        const kind = str(d.result && d.result.kind);
        events.push({ type: 'permission_resolved', requestId: str(d.requestId), optionId: kind === 'approved' ? 'approved' : 'denied' });
        break;
      }
      // copilot's turn is one model round trip, several per prompt, so its
      // turn_end is not the end of the reply; the next user message is.
      case 'assistant.turn_end':
      default:
        break;
    }
  }
  endTurn();
  return bound(events);
}

// transcriptToEvents picks the parser by agent name.
function transcriptToEvents(agent, raw) {
  const a = str(agent).toLowerCase();
  if (a === 'copilot') return copilotEventsToEvents(raw);
  if (a === 'claude') return claudeTranscriptToEvents(raw);
  return [];
}

module.exports = { claudeTranscriptToEvents, copilotEventsToEvents, transcriptToEvents, isSyntheticPrompt };
