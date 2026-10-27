'use strict';

// Agent Client Protocol (ACP) client side, transport-agnostic. The caller
// owns the child process and passes `send(obj)` to write one JSON-RPC message
// to it; incoming parsed messages are fed through `receive(msg)`.
//
// Verified live against gemini --acp (0.60.0). Shapes:
//   initialize       -> { protocolVersion, agentInfo, agentCapabilities, authMethods }
//   session/new      -> { sessionId, modes, models }
//   session/prompt   -> { stopReason }
//   session/update   <- notification { sessionId, update: { sessionUpdate, ... } }
//   session/request_permission <- request { sessionId, toolCall, options }
//
// The client advertises no fs or terminal capability, so an agent that asks
// for fs/read_text_file or terminal/create gets a -32601 and falls back to its
// own tools. That keeps the first version small; the hooks are here to add
// them later.

const PROTOCOL_VERSION = 1;
const METHOD_NOT_FOUND = -32601;

function createAcpClient({ send, onUpdate, onPermission, onNotification } = {}) {
  if (typeof send !== 'function') throw new TypeError('send is required');
  let nextId = 0;
  const pending = new Map();
  let closed = false;

  function request(method, params) {
    if (closed) return Promise.reject(new Error('acp client closed'));
    const id = ++nextId;
    const msg = { jsonrpc: '2.0', id, method, params: params || {} };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      try {
        send(msg);
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  function notify(method, params) {
    if (closed) return;
    send({ jsonrpc: '2.0', method, params: params || {} });
  }

  function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function replyError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  // Routes one parsed message. Responses settle their promise; server
  // notifications fan out; server requests get answered.
  function receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    const hasId = msg.id !== undefined && msg.id !== null;

    if (hasId && !msg.method) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error((msg.error && msg.error.message) || 'acp error');
        err.code = msg.error && msg.error.code;
        err.data = msg.error && msg.error.data;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;

    if (!hasId) {
      if (msg.method === 'session/update' && typeof onUpdate === 'function') {
        const params = msg.params || {};
        onUpdate({ sessionId: params.sessionId, update: params.update || {} });
      } else if (typeof onNotification === 'function') {
        onNotification(msg.method, msg.params || {});
      }
      return;
    }

    if (msg.method === 'session/request_permission') {
      const params = msg.params || {};
      const options = Array.isArray(params.options) ? params.options : [];
      Promise.resolve()
        .then(() => (typeof onPermission === 'function' ? onPermission(params) : null))
        .then((optionId) => {
          if (optionId === null || optionId === undefined || optionId === false) {
            reply(msg.id, { outcome: { outcome: 'cancelled' } });
          } else {
            reply(msg.id, { outcome: { outcome: 'selected', optionId: String(optionId) } });
          }
        })
        .catch(() => {
          // A failed prompt handler must still answer, or the agent hangs on
          // the request forever. Cancelling is the safe default.
          try { reply(msg.id, { outcome: { outcome: 'cancelled' } }); } catch (_) {}
        });
      void options;
      return;
    }

    replyError(msg.id, METHOD_NOT_FOUND, `Husk does not implement ${msg.method}`);
  }

  function initialize(clientInfo) {
    return request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: clientInfo || { name: 'husk', version: '0.0.0' },
    });
  }

  function newSession(cwd, mcpServers) {
    return request('session/new', { cwd, mcpServers: Array.isArray(mcpServers) ? mcpServers : [] });
  }

  function loadSession(sessionId, cwd, mcpServers) {
    return request('session/load', { sessionId, cwd, mcpServers: Array.isArray(mcpServers) ? mcpServers : [] });
  }

  function prompt(sessionId, blocks) {
    return request('session/prompt', { sessionId, prompt: blocks });
  }

  function cancel(sessionId) {
    notify('session/cancel', { sessionId });
  }

  // Session Models extension; gemini 0.60 and copilot 1.0.103 both answer {}.
  function setModel(sessionId, modelId) {
    return request('session/set_model', { sessionId, modelId });
  }

  function setMode(sessionId, modeId) {
    return request('session/set_mode', { sessionId, modeId });
  }

  // Rejects every in-flight request. Called when the child exits so the
  // renderer's awaiting turn settles instead of spinning.
  function close(reason) {
    closed = true;
    const err = new Error(reason || 'agent exited');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  return {
    request, notify, receive, initialize, newSession, loadSession, prompt, cancel, setMode, setModel, close,
    pendingCount: () => pending.size,
  };
}

// textPrompt wraps a user string as the single ACP text block a prompt takes.
// textPrompt builds the prompt blocks: the text, then any pasted images as
// ACP image blocks (base64 data plus mime type).
function textPrompt(text, images) {
  const blocks = [];
  const t = String(text || '');
  if (t.trim() || !Array.isArray(images) || !images.length) blocks.push({ type: 'text', text: t });
  for (const im of Array.isArray(images) ? images : []) {
    if (!im || !im.data) continue;
    blocks.push({ type: 'image', data: String(im.data), mimeType: String(im.mimeType || 'image/png') });
  }
  return blocks;
}

module.exports = { createAcpClient, textPrompt, PROTOCOL_VERSION, METHOD_NOT_FOUND };
