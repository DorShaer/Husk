'use strict';

// codex app-server, the JSON-RPC protocol the Codex CLI speaks on stdio, mapped
// onto Husk's chat events. Pure: every function takes one wire payload and
// returns chat events (or the reply to send), so the runtime stays a thin pipe.
//
// Verified live against codex-cli 0.167.0. Shapes:
//   initialize   -> { userAgent, codexHome }      then the `initialized` notification
//   model/list   -> { data: [{ id, displayName, description, hidden, isDefault }] }
//   thread/start -> { thread: { id }, model }
//   turn/start   -> { turn: { id } }
//   turn/interrupt { threadId, turnId }
//   item/*, turn/*, thread/* notifications carry the stream
//   item/commandExecution/requestApproval, item/fileChange/requestApproval
//     are server requests answered with { decision }

function str(v) { return v === null || v === undefined ? '' : String(v); }

const APP_SERVER_ARGS = ['app-server'];

// The model a launch command pins: `--model x`, `--model=x` or `-m x`.
// shortcut: only the model rides along, since app-server takes none of the
// interactive CLI's other flags; add them here when one is needed in chat.
function codexModel(agentCommand) {
  const tokens = str(agentCommand).trim().split(/\s+/).filter(Boolean);
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--model=')) return t.slice('--model='.length) || null;
    if ((t === '--model' || t === '-m') && tokens[i + 1]) return tokens[i + 1];
  }
  return null;
}

// Saved-session commands use `codex resume <id>`; app-server needs the
// same id explicitly on thread/resume instead of thread/start.
function codexResumeId(agentCommand) {
  const tokens = str(agentCommand).trim().split(/\s+/).filter(Boolean);
  const i = tokens.indexOf('resume', 1);
  const id = i < 0 ? '' : tokens[i + 1];
  return /^[A-Za-z0-9][A-Za-z0-9._-]{3,120}$/.test(id || '') ? id : null;
}

// One user turn as codex input items. Images go as data URLs.
function codexInput(text, images) {
  const input = [];
  const t = str(text);
  if (t.trim() || !Array.isArray(images) || !images.length) input.push({ type: 'text', text: t, text_elements: [] });
  for (const im of Array.isArray(images) ? images : []) {
    if (!im || !im.data) continue;
    input.push({ type: 'image', url: `data:${str(im.mimeType) || 'image/png'};base64,${str(im.data)}` });
  }
  return input;
}

function codexSession(threadResult, modelList) {
  const r = threadResult || {};
  const thread = r.thread || {};
  const current = str(r.model || thread.model);
  const available = (Array.isArray(modelList) ? modelList : [])
    .filter((m) => m && m.id && !m.hidden)
    .map((m) => ({ id: str(m.id), name: str(m.displayName || m.id), description: m.description ? str(m.description) : undefined }));
  const hit = available.find((m) => m.id === current);
  return {
    type: 'session',
    sessionId: str(thread.id),
    model: hit ? hit.name : (current || undefined),
    models: available.length ? { current, available } : undefined,
  };
}

// A unified diff split into the two sides the thread's diff view compares.
// Only the hunks are known, so each side is the hunk lines it took part in.
function diffSides(diff, kind) {
  const lines = str(diff).split('\n');
  if (!lines.some((l) => l.startsWith('@@'))) {
    if (kind === 'delete') return { oldText: str(diff), newText: '' };
    return { oldText: kind === 'add' ? null : '', newText: str(diff) };
  }
  const oldLines = [];
  const newLines = [];
  let inHunk = false;
  for (const l of lines) {
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk || l.startsWith('\\')) continue;
    if (l.startsWith('+')) newLines.push(l.slice(1));
    else if (l.startsWith('-')) oldLines.push(l.slice(1));
    else { const c = l.startsWith(' ') ? l.slice(1) : l; oldLines.push(c); newLines.push(c); }
  }
  return { oldText: kind === 'add' ? null : oldLines.join('\n'), newText: newLines.join('\n') };
}

const ITEM_STATUS = { inProgress: 'running', completed: 'done', failed: 'error', declined: 'error' };

// The shell wrapper codex runs a command under is noise on a card; the parsed
// action is what the model asked for.
function commandLabel(item) {
  const acts = Array.isArray(item.commandActions) ? item.commandActions : [];
  return acts.length === 1 && acts[0] && acts[0].command ? str(acts[0].command) : str(item.command);
}

function toolFromItem(item, done) {
  const ev = { type: 'tool', id: str(item.id), status: done ? (ITEM_STATUS[item.status] || 'done') : 'running' };
  switch (item.type) {
    case 'commandExecution':
      if (!done) Object.assign(ev, { title: 'Shell', kind: 'execute', detail: commandLabel(item), input: { command: commandLabel(item), cwd: str(item.cwd) } });
      else {
        if (typeof item.exitCode === 'number' && item.exitCode !== 0) ev.status = 'error';
        ev.output = str(item.aggregatedOutput);
      }
      return ev;
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      if (!done) Object.assign(ev, { title: 'Edit', kind: 'edit' });
      if (changes.length) {
        ev.detail = str(changes[0].path);
        ev.locations = changes.map((c) => str(c && c.path)).filter(Boolean);
        ev.diffs = changes.map((c) => Object.assign({ path: str(c.path) }, diffSides(c.diff, c.kind && c.kind.type)));
      }
      return ev;
    }
    case 'mcpToolCall':
      if (!done) Object.assign(ev, { title: `${str(item.server)}.${str(item.tool)}`, kind: 'other', input: item.arguments });
      else {
        if (item.error) { ev.status = 'error'; ev.output = str(item.error.message); }
        else if (item.result) ev.output = JSON.stringify(item.result.structuredContent || item.result.content, null, 2);
      }
      return ev;
    case 'dynamicToolCall':
      if (!done) Object.assign(ev, { title: str(item.tool) || 'Tool', kind: 'other', input: item.arguments });
      else if (item.success === false) ev.status = 'error';
      return ev;
    case 'collabAgentToolCall':
      if (!done) Object.assign(ev, { title: str(item.tool) || 'Agent', kind: 'think', detail: str(item.prompt).replace(/\s+/g, ' ').slice(0, 160) });
      return ev;
    case 'webSearch':
      if (!done) Object.assign(ev, { title: 'Web search', kind: 'fetch', detail: str(item.query) });
      return ev;
    default:
      return null;
  }
}

// normalizeCodexNotification maps one server notification to chat events.
function normalizeCodexNotification(method, params) {
  const p = params || {};
  switch (method) {
    case 'turn/started':
      return [{ type: 'turn_start' }];
    case 'item/agentMessage/delta':
      return p.delta ? [{ type: 'text', text: str(p.delta) }] : [];
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      return p.delta ? [{ type: 'thought', text: str(p.delta) }] : [];
    case 'item/started': {
      const item = p.item || {};
      if (item.type === 'agentMessage' || item.type === 'reasoning') return [{ type: 'block_end' }];
      const tool = toolFromItem(item, false);
      return tool ? [tool] : [];
    }
    case 'item/completed': {
      const item = p.item || {};
      if (item.type === 'agentMessage') {
        return str(item.text).trim() ? [{ type: 'text_final', text: str(item.text) }, { type: 'block_end' }] : [{ type: 'block_end' }];
      }
      if (item.type === 'reasoning') return [{ type: 'block_end' }];
      const tool = toolFromItem(item, true);
      return tool ? [tool] : [];
    }
    case 'turn/plan/updated':
      return [{ type: 'plan', entries: (Array.isArray(p.plan) ? p.plan : []).map((e) => ({ content: str(e && e.step), status: str(e && e.status) === 'inProgress' ? 'in_progress' : str(e && e.status), priority: '' })) }];
    case 'thread/tokenUsage/updated': {
      const u = p.tokenUsage || {};
      const used = Number(u.last && u.last.totalTokens);
      const size = Number(u.modelContextWindow);
      return isFinite(used) && isFinite(size) && size > 0 ? [{ type: 'usage', used, size }] : [];
    }
    case 'thread/name/updated':
      return p.threadName ? [{ type: 'title', title: str(p.threadName) }] : [];
    case 'turn/completed': {
      const turn = p.turn || {};
      const failed = turn.status === 'failed';
      return [{
        type: 'turn_end',
        stopReason: failed ? 'error' : (turn.status === 'interrupted' ? 'cancelled' : 'end_turn'),
        isError: failed,
        durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : undefined,
        text: failed && turn.error && turn.error.message ? str(turn.error.message) : undefined,
      }];
    }
    // A failure codex retries on its own is progress, not the end of the turn;
    // the final one arrives with turn/completed.
    case 'error':
      return p.willRetry && p.error && p.error.message ? [{ type: 'status', text: str(p.error.message) }] : [];
    default:
      return [];
  }
}

const APPROVALS = {
  'item/commandExecution/requestApproval': 'Run command',
  'item/fileChange/requestApproval': 'Apply changes',
};
const DECISION_OPTIONS = [
  { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
  { optionId: 'acceptForSession', name: 'Allow for session', kind: 'allow_always' },
  { optionId: 'decline', name: 'Deny', kind: 'reject_once' },
];

// normalizeCodexApproval maps an approval request to a permission event, or
// null for a server request Husk has no card for.
function normalizeCodexApproval(requestId, method, params) {
  const title = APPROVALS[method];
  if (!title) return null;
  const p = params || {};
  // codex names the answers it will take for a command; a file change takes all three.
  const offered = Array.isArray(p.availableDecisions) ? p.availableDecisions.filter((d) => typeof d === 'string') : null;
  const options = DECISION_OPTIONS.filter((o) => !offered || offered.includes(o.optionId) || o.optionId === 'decline');
  // The card is what gets approved, so it carries the command exactly as it
  // will run, never the parsed summary a tool card shows.
  const command = str(p.command);
  return {
    type: 'permission',
    requestId: str(requestId),
    toolCallId: p.itemId !== undefined ? str(p.itemId) : undefined,
    title,
    detail: [command, str(p.reason)].filter(Boolean).join('\n') || undefined,
    input: command ? { command, cwd: str(p.cwd) } : undefined,
    options,
  };
}

// The reply to an approval request. No answer at all (a dismissed card, an
// exiting child) cancels, which also ends the turn.
function codexDecision(optionId) {
  const id = str(optionId);
  return { decision: DECISION_OPTIONS.some((o) => o.optionId === id) ? id : 'cancel' };
}

module.exports = {
  APP_SERVER_ARGS, codexModel, codexResumeId, codexInput, codexSession, diffSides,
  normalizeCodexNotification, normalizeCodexApproval, codexDecision,
};
