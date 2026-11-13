'use strict';

// Turns an agent's on-disk session log into Husk chat events, so resuming a
// past session in Chat view shows the conversation so far instead of an empty
// thread. Agent formats sampled from real session logs:
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
//   codex    ~/.codex/sessions/**/rollout-*.jsonl (also archived_sessions)
//            response_item messages/tool calls plus event_msg turn boundaries
// Output uses the vocabulary in chat-events.js and replays through its
// reducer. Pure: no fs here, the caller reads the file.

const { toolDetail, kindForTool } = require('./chat-events');

const MAX_EVENTS = 4000;
const MAX_TEXT = 400000;

const { withoutContext } = require('./brain');

function str(v) { return v === null || v === undefined ? '' : String(v); }

function timestampField(...records) {
  for (const record of records) {
    const raw = record && (record.timestamp || (record.message && record.message.timestamp));
    if (raw === undefined || raw === null || raw === '') continue;
    const value = typeof raw === 'number' ? (raw < 1e11 ? raw * 1000 : raw) : Date.parse(str(raw));
    if (Number.isFinite(value) && value > 0) return { at: value };
  }
  return {};
}

// Synthetic prompts the CLI writes for itself (local command echoes, hook
// output, system reminders, background task notifications) start with a tag
// and are not the user's words.
function isSyntheticPrompt(text) {
  const t = str(text).trimStart();
  return t.startsWith('<local-command') || t.startsWith('<command-') || t.startsWith('<system-reminder') || t.startsWith('<bash-input') || t.startsWith('<bash-stdout') || t.startsWith('<bash-stderr') || t.startsWith('<task-notification');
}

// A `user` line the CLI authored on the user's behalf: a background task
// notification, the summary it writes after compacting the conversation, a
// companion line for an attachment. The fields are the ones claude writes as
// of 2.1.x; the tag check covers logs that predate them.
function isSystemTurn(o, text) {
  if (!o) return false;
  if (o.promptSource === 'system' || o.turnOrigin === 'task_notification' || o.turnCompanion) return true;
  if (o.origin && o.origin.kind === 'task-notification') return true;
  if (o.isCompactSummary || o.isVisibleInTranscriptOnly) return true;
  return isSyntheticPrompt(text);
}

// What the thread shows in place of a system turn: a one-line status for the
// kinds a reader would want to know about, nothing for the rest.
function systemTurnStatus(o, text) {
  const t = str(text).trimStart();
  if (o.isCompactSummary || o.isVisibleInTranscriptOnly) return 'The agent summarized the conversation so far to free up context.';
  if (o.turnOrigin === 'task_notification' || (o.origin && o.origin.kind === 'task-notification') || t.startsWith('<task-notification')) {
    const m = /<summary>([\s\S]*?)<\/summary>/.exec(t);
    const summary = m ? m[1].replace(/\s+/g, ' ').trim() : '';
    return summary ? 'Background task: ' + summary : 'A background task finished.';
  }
  return '';
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
      // The tag check runs on the whole string here and per block below: the
      // CLI attaches a system reminder as its own block beside the user's words.
      if (isSystemTurn(o, typeof content === 'string' ? content : '')) {
        const note = systemTurnStatus(o, typeof content === 'string' ? content : blockText(content));
        if (note) events.push({ type: 'status', text: note });
        continue;
      }
      if (typeof content === 'string') {
        if (!content.trim()) continue;
        endTurn();
        events.push(Object.assign({ type: 'user', text: withoutContext(content) }, timestampField(o)));
        turnOpen = true;
        continue;
      }
      if (!Array.isArray(content)) continue;
      const texts = [];
      for (const c of content) {
        if (!c || c.type !== 'text' || !str(c.text).trim()) continue;
        if (isSyntheticPrompt(c.text)) {
          const note = systemTurnStatus(o, c.text);
          if (note) events.push({ type: 'status', text: note });
          continue;
        }
        texts.push(c);
      }
      const results = content.filter((c) => c && c.type === 'tool_result');
      for (const r of results) {
        events.push({ type: 'tool', id: str(r.tool_use_id), status: r.is_error ? 'error' : 'done', output: blockText(r.content) });
      }
      if (texts.length) {
        endTurn();
        events.push(Object.assign({ type: 'user', text: withoutContext(texts.map((c) => str(c.text)).join('\n')) }, timestampField(o)));
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
      if (b.type === 'text' && str(b.text).trim()) events.push(Object.assign({ type: 'text_final', text: str(b.text) }, timestampField(o)));
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
        events.push(Object.assign({ type: 'user', text: withoutContext(d.content) }, timestampField(o, d)));
        turnOpen = true;
        break;
      case 'assistant.turn_start':
        if (!turnOpen) { events.push({ type: 'turn_start' }); turnOpen = true; }
        break;
      case 'assistant.message': {
        if (!turnOpen) { events.push({ type: 'turn_start' }); turnOpen = true; }
        if (str(d.content).trim()) events.push(Object.assign({ type: 'text_final', text: str(d.content) }, timestampField(o, d)));
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

// Codex rollouts include response items and UI events for the same messages.
// Read response items when present so the conversation is not shown twice.
function codexTranscriptToEvents(raw) {
  const rows = parseLines(raw);
  const hasMessages = rows.some((o) => o.type === 'response_item' && o.payload && o.payload.type === 'message' && ['user', 'assistant'].includes(o.payload.role));
  const events = [];
  let turnOpen = false;
  const endTurn = () => { if (turnOpen) { events.push({ type: 'turn_end', stopReason: 'end_turn' }); turnOpen = false; } };
  const message = (role, text, row) => {
    if (!text.trim() || isSyntheticPrompt(text)) return;
    if (role === 'user') {
      // Codex records its instruction/environment preamble as user messages.
      if (/^\s*<(?:environment_context|permissions instructions|turn_aborted|user_instructions)(?:\s|>)/.test(text) || text.startsWith('# AGENTS.md instructions')) return;
      text = withoutContext(text);
      if (!text.trim()) return;
      endTurn();
      events.push(Object.assign({ type: 'user', text }, timestampField(row)));
    } else {
      if (!turnOpen) events.push({ type: 'turn_start' });
      events.push(Object.assign({ type: 'text_final', text }, timestampField(row)));
      events.push({ type: 'block_end' });
    }
    turnOpen = true;
  };
  for (const row of rows) {
    const p = row.payload || {};
    if (row.type === 'response_item') {
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        const text = (Array.isArray(p.content) ? p.content : [])
          .filter((c) => c && ['text', 'input_text', 'output_text'].includes(c.type))
          .map((c) => str(c.text)).join('\n');
        message(p.role, text, row);
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let input = p.arguments || p.input;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_) {} }
        events.push({ type: 'tool', id: str(p.call_id), title: str(p.name), kind: kindForTool(p.name), status: 'running', input, detail: toolDetail(p.name, input) });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
        events.push({ type: 'tool', id: str(p.call_id), status: 'done', output });
      }
    } else if (row.type === 'event_msg') {
      if (!hasMessages && p.type === 'user_message') message('user', str(p.message), row);
      if (!hasMessages && p.type === 'agent_message') message('assistant', str(p.message), row);
      if (p.type === 'task_complete' || p.type === 'turn_aborted') endTurn();
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
  if (a === 'codex') return codexTranscriptToEvents(raw);
  return [];
}

module.exports = { codexTranscriptToEvents, claudeTranscriptToEvents, copilotEventsToEvents, transcriptToEvents, isSyntheticPrompt, isSystemTurn };
