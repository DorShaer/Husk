'use strict';

// Wrapped: this file is also loaded as a classic renderer script, where every
// top-level name would land in the page's shared scope.
(function () {

// Husk's chat event model. Two agent protocols (ACP, claude stream-json) are
// normalized into one small vocabulary so the renderer never knows which CLI
// it is talking to. Everything here is pure: normalizers take one wire
// message and return an array of chat events; reduceThread folds events into
// an immutable thread state the renderer paints.
//
// Chat events:
//   { type: 'session', sessionId, model?, modes?, commands?, models? { current, available: [{ id, name }] } }
//   { type: 'turn_start' }
//   { type: 'user', text, images? [{ mimeType, data? }] }  the user's prompt (renderer-side)
//   { type: 'text', text }                       append to the open assistant text
//   { type: 'text_final', text }                 replace the open text (claude full message)
//   { type: 'block_end' }                        close the open text/thought block
//   { type: 'thought', text }                    append to the open thought block
//   { type: 'tool', id, title?, kind?, status?, detail?, input?, output?, diffs?, locations? }
//   { type: 'permission', requestId, toolCallId?, title, detail?, input?, options: [{ optionId, name, kind }] }
//   { type: 'permission_resolved', requestId, optionId }
//   { type: 'plan', entries: [{ content, status, priority }] }
//   { type: 'commands', commands: [{ name, description }] }
//   { type: 'title', title }                     agent-chosen session title
//   { type: 'usage', used, size }                context window tokens used / size
//   { type: 'billing', plan }                    'subscription' when the CLI reports plan windows
//   { type: 'mode', modeId }
//   { type: 'turn_end', stopReason, isError?, durationMs?, costUsd?, usage? }
//   { type: 'status', text }
//   { type: 'truncate', key }                   drop the item with this key and everything after it
//   { type: 'error', text }
//
// Thread state:
//   { items: [], turnOpen: bool, sessionId, model, commands, modes, pending: [requestId] }
// Item kinds: user | text | thought | tool | permission | plan | meta

const TOOL_STATUS = { pending: 'running', in_progress: 'running', completed: 'done', failed: 'error' };

function str(v) { return v === null || v === undefined ? '' : String(v); }

// ─── ACP ─────────────────────────────────────────────────────────────────────

// acpContentText flattens an ACP tool content list into display text and a
// list of diffs. Content entries are { type: 'content', content: {type,text} }
// | { type: 'diff', path, oldText, newText } | { type: 'terminal', terminalId }.
function acpContentText(list) {
  const out = { text: '', diffs: [] };
  if (!Array.isArray(list)) return out;
  const parts = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'content' && c.content && c.content.type === 'text') parts.push(str(c.content.text));
    else if (c.type === 'diff') out.diffs.push({ path: str(c.path), oldText: c.oldText === null || c.oldText === undefined ? null : str(c.oldText), newText: str(c.newText) });
    else if (c.type === 'terminal') parts.push(`[terminal ${str(c.terminalId)}]`);
  }
  out.text = parts.join('\n');
  return out;
}

// normalizeAcpUpdate maps one session/update payload (the `update` object)
// to chat events. Verified against gemini --acp 0.60.0 output.
function normalizeAcpUpdate(update) {
  if (!update || typeof update !== 'object') return [];
  const kind = update.sessionUpdate;
  switch (kind) {
    case 'agent_message_chunk': {
      const c = update.content;
      if (c && c.type === 'text') return [{ type: 'text', text: str(c.text) }];
      if (c && c.type === 'image') return [{ type: 'text', text: '[image]' }];
      return [];
    }
    case 'agent_thought_chunk': {
      const c = update.content;
      if (c && c.type === 'text') return [{ type: 'thought', text: str(c.text) }];
      return [];
    }
    case 'tool_call':
    case 'tool_call_update': {
      const ev = { type: 'tool', id: str(update.toolCallId) };
      if (update.title !== undefined) ev.title = str(update.title);
      if (update.kind !== undefined) ev.kind = str(update.kind);
      if (update.status !== undefined) ev.status = TOOL_STATUS[update.status] || 'running';
      else if (kind === 'tool_call') ev.status = 'running';
      if (update.rawInput !== undefined) ev.input = update.rawInput;
      if (update.rawOutput !== undefined) ev.output = typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2);
      if (Array.isArray(update.content) && update.content.length) {
        const flat = acpContentText(update.content);
        if (flat.text) ev.output = flat.text;
        if (flat.diffs.length) ev.diffs = flat.diffs;
      }
      if (Array.isArray(update.locations) && update.locations.length) {
        ev.locations = update.locations.map((l) => str(l && l.path)).filter(Boolean);
        if (!ev.detail) ev.detail = ev.locations[0];
      }
      return [ev];
    }
    case 'plan':
      return [{ type: 'plan', entries: (Array.isArray(update.entries) ? update.entries : []).map((e) => ({ content: str(e && e.content), status: str(e && e.status), priority: str(e && e.priority) })) }];
    case 'available_commands_update':
      return [{ type: 'commands', commands: (Array.isArray(update.availableCommands) ? update.availableCommands : []).map((c) => ({ name: str(c && c.name), description: str(c && c.description) })) }];
    case 'current_mode_update':
      return [{ type: 'mode', modeId: str(update.currentModeId) }];
    // copilot names the session after the first prompt and reports context use.
    case 'session_info_update':
      return update.title ? [{ type: 'title', title: str(update.title) }] : [];
    case 'usage_update': {
      const used = Number(update.used);
      const size = Number(update.size);
      return isFinite(used) && isFinite(size) && size > 0 ? [{ type: 'usage', used, size }] : [];
    }
    case 'user_message_chunk':
    case 'config_option_update':
      return [];
    default:
      return [];
  }
}

// normalizeAcpPermission maps a session/request_permission params object to
// a permission event. The caller supplies requestId (the JSON-RPC id).
function normalizeAcpPermission(requestId, params) {
  const p = params || {};
  const tc = p.toolCall || {};
  const flat = acpContentText(tc.content);
  return {
    type: 'permission',
    requestId: str(requestId),
    toolCallId: tc.toolCallId !== undefined ? str(tc.toolCallId) : undefined,
    title: str(tc.title) || 'Tool call',
    detail: flat.text || undefined,
    input: tc.rawInput,
    options: (Array.isArray(p.options) ? p.options : []).map((o) => ({ optionId: str(o && o.optionId), name: str(o && o.name), kind: str(o && o.kind) })),
  };
}

// normalizeAcpSession maps a session/new result to the session event.
function normalizeAcpSession(result) {
  const r = result || {};
  const modes = r.modes || {};
  const models = r.models || {};
  const current = Array.isArray(models.availableModels) ? models.availableModels.find((m) => m && m.modelId === models.currentModelId) : null;
  return {
    type: 'session',
    sessionId: str(r.sessionId),
    model: current ? str(current.name || current.modelId) : (models.currentModelId ? str(models.currentModelId) : undefined),
    models: Array.isArray(models.availableModels) && models.availableModels.length
      ? { current: str(models.currentModelId), available: dedupeModels(models.availableModels) }
      : undefined,
    modes: Array.isArray(modes.availableModes) ? { current: str(modes.currentModeId), available: modes.availableModes.map((m) => ({ id: str(m.id), name: str(m.name), description: str(m.description) })) } : undefined,
  };
}

// copilot lists 'auto' twice; one row per id, first name wins.
function dedupeModels(list) {
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m || !m.modelId || seen.has(String(m.modelId))) continue;
    seen.add(String(m.modelId));
    out.push({ id: str(m.modelId), name: str(m.name || m.modelId), description: m.description ? str(m.description) : undefined });
  }
  return out;
}

// ─── claude stream-json ──────────────────────────────────────────────────────

// toolDetail picks the one-line summary Husk shows on a collapsed tool card.
function toolDetail(name, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const v = inp.command || inp.file_path || inp.path || inp.pattern || inp.url || inp.query || inp.description || inp.prompt || '';
  const s = str(v).replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

function blockContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && c.type === 'text' ? str(c.text) : '')).filter(Boolean).join('\n');
}

// normalizeClaudeEvent maps one stream-json line to chat events.
function normalizeClaudeEvent(ev) {
  if (!ev || typeof ev !== 'object') return [];
  switch (ev.type) {
    case 'system': {
      if (ev.subtype === 'init') {
        return [{
          type: 'session',
          sessionId: str(ev.session_id),
          model: ev.model ? str(ev.model) : undefined,
          commands: Array.isArray(ev.slash_commands) ? ev.slash_commands.map((n) => ({ name: str(n), description: '' })) : undefined,
        }];
      }
      if (ev.subtype === 'informational' && ev.content) return [{ type: 'status', text: str(ev.content) }];
      return [];
    }
    case 'stream_event': {
      const e = ev.event || {};
      if (e.type === 'message_start') return [{ type: 'turn_start' }];
      if (e.type === 'content_block_start') return [{ type: 'block_end' }];
      if (e.type === 'content_block_delta') {
        const d = e.delta || {};
        if (d.type === 'text_delta' && d.text) return [{ type: 'text', text: str(d.text) }];
        if (d.type === 'thinking_delta' && d.thinking) return [{ type: 'thought', text: str(d.thinking) }];
        return [];
      }
      if (e.type === 'content_block_stop') return [{ type: 'block_end' }];
      return [];
    }
    case 'assistant': {
      const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      const out = [];
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && str(b.text).trim()) out.push({ type: 'text_final', text: str(b.text) });
        else if (b.type === 'tool_use') {
          out.push({ type: 'tool', id: str(b.id), title: str(b.name), kind: kindForTool(b.name), status: 'running', detail: toolDetail(b.name, b.input), input: b.input });
        }
      }
      return out;
    }
    case 'user': {
      const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      const out = [];
      for (const b of content) {
        if (b && b.type === 'tool_result') {
          out.push({ type: 'tool', id: str(b.tool_use_id), status: b.is_error ? 'error' : 'done', output: blockContentText(b.content) });
        }
      }
      return out;
    }
    case 'control_request': {
      const r = ev.request || {};
      if (r.subtype !== 'can_use_tool') return [];
      const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }];
      // claude attaches the permission rules it would offer in its own TUI
      // ("always allow this command", "accept edits for the session"). The
      // allow-session answer hands those back as updatedPermissions.
      if (Array.isArray(r.permission_suggestions) && r.permission_suggestions.length) {
        options.push({ optionId: 'allow-session', name: 'Allow for session', kind: 'allow_always' });
      }
      options.push({ optionId: 'deny', name: 'Deny', kind: 'reject_once' });
      return [{
        type: 'permission',
        requestId: str(ev.request_id),
        toolCallId: r.tool_use_id !== undefined ? str(r.tool_use_id) : undefined,
        title: str(r.display_name || r.tool_name) || 'Tool call',
        detail: toolDetail(r.tool_name, r.input) || (r.description ? str(r.description) : undefined),
        input: r.input,
        options,
      }];
    }
    // Only subscription accounts get plan windows; an API-key account never
    // sees this event. It is the one reliable billing signal the CLI gives.
    case 'rate_limit_event': {
      const info = ev.rate_limit_info || {};
      const kind = str(info.rateLimitType);
      return kind === 'five_hour' || kind === 'seven_day' || info.unifiedWindows ? [{ type: 'billing', plan: 'subscription' }] : [];
    }
    case 'result':
      return [{
        type: 'turn_end',
        stopReason: ev.is_error ? 'error' : str(ev.stop_reason || ev.subtype || 'end_turn'),
        isError: !!ev.is_error,
        durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : undefined,
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        usage: ev.usage || undefined,
        text: ev.is_error && ev.result ? str(ev.result) : undefined,
      }];
    default:
      return [];
  }
}

function kindForTool(name) {
  const n = str(name).toLowerCase();
  if (n === 'bash') return 'execute';
  if (n === 'read' || n === 'glob' || n === 'grep') return 'read';
  if (n === 'edit' || n === 'write' || n === 'notebookedit' || n === 'multiedit') return 'edit';
  if (n === 'webfetch' || n === 'websearch') return 'fetch';
  if (n === 'task' || n === 'agent') return 'think';
  return 'other';
}

// ─── reducer ─────────────────────────────────────────────────────────────────

function emptyThread() {
  return { items: [], turnOpen: false, sessionId: null, model: null, commands: [], modes: null, title: null, usage: null, billing: null, models: null, pending: [], seq: 0 };
}

function lastItem(state) { return state.items.length ? state.items[state.items.length - 1] : null; }

function withItems(state, items, extra) {
  return Object.assign({}, state, { items }, extra || {});
}

function appendItem(state, item, extra) {
  const seq = state.seq + 1;
  return withItems(state, state.items.concat([Object.assign({ key: 'i' + seq }, item)]), Object.assign({ seq }, extra || {}));
}

function replaceLast(state, item) {
  const items = state.items.slice(0, -1).concat([item]);
  return withItems(state, items);
}

// appendStream appends to the open block of `kind`, or starts one. A block of
// another kind that is still open (a thought the agent moved on from without
// any end marker, as ACP agents do) is closed first so it stops reading as
// live.
function appendStream(state, kind, text) {
  const last = lastItem(state);
  if (last && last.kind === kind && last.open) {
    return replaceLast(state, Object.assign({}, last, { text: last.text + text }));
  }
  return appendItem(closeOpen(state), { kind, text, open: true });
}

function closeOpen(state) {
  const last = lastItem(state);
  if (last && last.open) return replaceLast(state, Object.assign({}, last, { open: false }));
  return state;
}

// reduceThread folds one chat event into the thread state. Never mutates.
function reduceThread(state, event) {
  const s = state || emptyThread();
  if (!event || typeof event !== 'object') return s;
  switch (event.type) {
    case 'user':
      return appendItem(closeOpen(s), Object.assign({ kind: 'user', text: str(event.text) }, Array.isArray(event.images) && event.images.length ? { images: event.images.map((im) => ({ mimeType: str(im && im.mimeType) || 'image/png', data: im && im.data ? str(im.data) : undefined })) } : {}), { turnOpen: true });
    case 'session':
      return Object.assign({}, s, {
        sessionId: event.sessionId || s.sessionId,
        model: event.model || s.model,
        commands: Array.isArray(event.commands) ? event.commands : s.commands,
        modes: event.modes || s.modes,
        models: event.models || s.models,
      });
    case 'turn_start':
      return Object.assign({}, closeOpen(s), { turnOpen: true });
    case 'text':
      return appendStream(s, 'text', str(event.text));
    case 'thought':
      return appendStream(s, 'thought', str(event.text));
    case 'block_end':
      return closeOpen(s);
    case 'text_final': {
      // Streamed deltas already built this block; the final message carries
      // the authoritative text. Replace the latest text block when there is
      // one in this turn, else append.
      const idx = findLastIndex(s.items, (it) => it.kind === 'text' && !it.final);
      if (idx === -1) return appendItem(s, { kind: 'text', text: str(event.text), open: false, final: true });
      const items = s.items.slice();
      items[idx] = Object.assign({}, items[idx], { text: str(event.text), open: false, final: true });
      return withItems(s, items);
    }
    case 'tool': {
      const idx = findLastIndex(s.items, (it) => it.kind === 'tool' && it.id === event.id);
      const patch = {};
      for (const k of ['title', 'kind', 'status', 'detail', 'input', 'output', 'diffs', 'locations']) {
        if (event[k] !== undefined) patch[k === 'kind' ? 'toolKind' : k] = event[k];
      }
      if (idx === -1) {
        return appendItem(closeOpen(s), Object.assign({ kind: 'tool', id: event.id, title: 'Tool', toolKind: 'other', status: 'running' }, patch));
      }
      const items = s.items.slice();
      items[idx] = Object.assign({}, items[idx], patch);
      return withItems(s, items);
    }
    case 'permission': {
      let base = closeOpen(s);
      // Some agents ask before announcing the tool call (gemini does), and
      // the later tool_call_update carries no title. Seed the card from the
      // request so the thread never shows a nameless "Tool".
      if (event.toolCallId) {
        const ti = findLastIndex(base.items, (it) => it.kind === 'tool' && it.id === event.toolCallId);
        if (ti === -1) {
          base = appendItem(base, { kind: 'tool', id: event.toolCallId, title: event.title || 'Tool', toolKind: 'other', status: 'running', detail: event.detail, input: event.input });
        } else if (!base.items[ti].title || base.items[ti].title === 'Tool') {
          const items = base.items.slice();
          items[ti] = Object.assign({}, items[ti], { title: event.title || items[ti].title });
          base = withItems(base, items);
        }
      }
      const next = appendItem(base, {
        kind: 'permission', requestId: event.requestId, toolCallId: event.toolCallId, title: event.title,
        detail: event.detail, input: event.input, options: event.options || [], decision: null,
      });
      return Object.assign({}, next, { pending: next.pending.concat([event.requestId]) });
    }
    case 'permission_resolved': {
      const idx = findLastIndex(s.items, (it) => it.kind === 'permission' && it.requestId === event.requestId);
      const pending = s.pending.filter((id) => id !== event.requestId);
      if (idx === -1) return Object.assign({}, s, { pending });
      const items = s.items.slice();
      items[idx] = Object.assign({}, items[idx], { decision: str(event.optionId) });
      return withItems(s, items, { pending });
    }
    case 'plan': {
      const idx = findLastIndex(s.items, (it) => it.kind === 'plan');
      if (idx !== -1 && s.turnOpen) {
        const items = s.items.slice();
        items[idx] = Object.assign({}, items[idx], { entries: event.entries });
        return withItems(s, items);
      }
      return appendItem(closeOpen(s), { kind: 'plan', entries: event.entries || [] });
    }
    case 'commands':
      return Object.assign({}, s, { commands: event.commands || [] });
    case 'title':
      return Object.assign({}, s, { title: str(event.title) });
    case 'usage':
      return Object.assign({}, s, { usage: { used: event.used, size: event.size } });
    case 'mode':
      return Object.assign({}, s, { modes: Object.assign({}, s.modes || {}, { current: event.modeId }) });
    case 'billing':
      return Object.assign({}, s, { billing: str(event.plan) || null });
    case 'turn_end': {
      const closed = closeOpen(s);
      // The CLI's total_cost_usd is API list price. On a subscription nothing
      // is billed per turn, so the figure would only alarm; it is dropped.
      const costUsd = s.billing === 'subscription' ? undefined : event.costUsd;
      const meta = { kind: 'meta', stopReason: event.stopReason, isError: !!event.isError, durationMs: event.durationMs, costUsd, text: event.text };
      return appendItem(closed, meta, { turnOpen: false, pending: [] });
    }
    // Edit and resend: the thread is cut from the edited prompt onward so the
    // new prompt takes its place. The agent's own memory of the old exchange
    // is not rewound; this is the view, and the reply that follows.
    case 'truncate': {
      const idx = s.items.findIndex((it) => it.key === event.key);
      if (idx === -1) return s;
      return withItems(s, s.items.slice(0, idx), { turnOpen: false, pending: [] });
    }
    case 'error':
      return appendItem(closeOpen(s), { kind: 'meta', isError: true, text: str(event.text) }, { turnOpen: false });
    case 'status':
      return appendItem(closeOpen(s), { kind: 'meta', isError: false, text: str(event.text) });
    default:
      return s;
  }
}

function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

// Loaded two ways: required by main/preload, and as a classic script by the
// renderer so the thread reducer runs in-process instead of across the bridge.
// A classic script shares the page's top-level scope with every other one, so
// nothing here may claim a bare global name (wfx-dom.js already owns 'api').
(function publish(exports) {
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  if (typeof window !== 'undefined') window.HuskChatEvents = exports;
})({
  normalizeAcpUpdate, normalizeAcpPermission, normalizeAcpSession,
  normalizeClaudeEvent, toolDetail, kindForTool,
  emptyThread, reduceThread,
});
})();
