'use strict';

// claude headless chat over stream-json, the wire the Agent SDK uses. Verified
// live on 2026-10-26: `claude -p --input-format stream-json --output-format
// stream-json --verbose --include-partial-messages --permission-prompt-tool
// stdio` reads user lines on stdin and writes one JSON event per line:
//   system/init, stream_event (message_start, content_block_delta ...),
//   assistant (full message, tool_use blocks), user (tool_result blocks),
//   control_request (subtype can_use_tool, answered on stdin), result.
// Permission prompts only reach stdin after the host sends an `initialize`
// control request first; without it (or with `--permission-prompts host`
// alone) the CLI auto-denies with permission_decision source "config".

// claudeChatArgs builds the argv for an interactive-over-stdin chat child.
// userFlags are the flags typed in the agent command (e.g. a pinned --model).
function claudeChatArgs({ userFlags = [], resume = null, sessionId = null } = {}) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
  ];
  if (resume) args.push('--resume', String(resume));
  else if (sessionId) args.push('--session-id', String(sessionId));
  for (const f of userFlags) if (typeof f === 'string' && f) args.push(f);
  return args;
}

// encodeUserMessage is one user turn as the stdin line claude expects.
// images: [{ mimeType, data }] with data base64, the Messages API image block.
function encodeUserMessage(text, images) {
  const content = [];
  const t = String(text || '');
  if (t.trim() || !Array.isArray(images) || !images.length) content.push({ type: 'text', text: t });
  for (const im of Array.isArray(images) ? images : []) {
    if (!im || !im.data) continue;
    content.push({ type: 'image', source: { type: 'base64', media_type: String(im.mimeType || 'image/png'), data: String(im.data) } });
  }
  return { type: 'user', message: { role: 'user', content } };
}

// encodePermissionResponse answers a control_request/can_use_tool. Allow
// passes the tool's input back (optionally edited); deny carries a message
// the model reads. updatedPermissions, when given, are the CLI's own
// permission_suggestions handed back so the rule persists for the session.
function encodePermissionResponse(requestId, allow, input, message, updatedPermissions) {
  const response = allow
    ? { behavior: 'allow', updatedInput: input || {} }
    : { behavior: 'deny', message: message || 'The user declined this tool call.' };
  if (allow && Array.isArray(updatedPermissions) && updatedPermissions.length) response.updatedPermissions = updatedPermissions;
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  };
}

// encodeInterrupt asks the running turn to stop without ending the process.
function encodeInterrupt(requestId) {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

// encodeInitialize is the host handshake that turns on stdin permission
// prompts. Sent once, before the first user message.
function encodeInitialize(requestId) {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } };
}

// isPermissionRequest picks the one control_request Husk must answer.
function isPermissionRequest(ev) {
  return !!(ev && ev.type === 'control_request' && ev.request && ev.request.subtype === 'can_use_tool');
}

module.exports = {
  claudeChatArgs, encodeUserMessage, encodePermissionResponse, encodeInterrupt, encodeInitialize, isPermissionRequest,
};
