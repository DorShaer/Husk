#!/usr/bin/env node
'use strict';

// A deterministic Agent Client Protocol agent for Chat-mode e2e. Speaks
// newline-delimited JSON-RPC 2.0 over stdio the way gemini --acp does, and on
// each prompt plays a fixed turn: a thought, streamed text, one tool call that
// asks for permission, a diff update, then a closing line. The permission
// answer is echoed back in the closing text so a test can assert on the
// client's choice. `session/cancel` ends the turn with stopReason cancelled.

let buf = '';
let sessionCounter = 0;
let serverReq = 0;
const waitingPermission = new Map();
let cancelled = false;
let lastModel = 'fake-1';

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function notify(sessionId, update) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const DEFAULT_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
// Kiro names its choices Yes / Always / No.
const KIRO_OPTIONS = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'always', name: 'Always', kind: 'allow_always' },
  { optionId: 'no', name: 'No', kind: 'reject_once' },
];
const STRING_PATCH = '*** Begin Patch\n*** Add File: greeting.txt\n+hello from husk\n*** End Patch';

function askPermission(sessionId, toolCallId, flavor) {
  const id = 'srv-' + (++serverReq);
  return new Promise((resolve) => {
    waitingPermission.set(id, resolve);
    send({
      jsonrpc: '2.0', id, method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId, title: 'write greeting.txt', kind: 'edit', rawInput: flavor ? STRING_PATCH : { path: 'greeting.txt', content: 'hello from husk' } },
        options: flavor ? KIRO_OPTIONS : DEFAULT_OPTIONS,
      },
    });
  });
}

async function runTurn(id, params) {
  const sessionId = params.sessionId;
  const text = (params.prompt || []).map((b) => (b && b.type === 'text' ? b.text : '')).join('');
  const imageCount = (params.prompt || []).filter((b) => b && b.type === 'image' && b.data).length;
  cancelled = false;
  // A prompt starting 'copilot:' plays the copilot and kiro shape: a session
  // title, a usage report, a plain-string patch as rawInput and Yes / Always
  // / No permission options. Every other prompt plays the gemini shape.
  const flavor = text.startsWith('copilot:');
  if (flavor) {
    notify(sessionId, { sessionUpdate: 'session_info_update', title: 'Greeting file' });
    notify(sessionId, { sessionUpdate: 'usage_update', used: 3200, size: 128000 });
  }
  // A prompt of exactly 'exit now' ends the process mid-turn, for tests of
  // an agent that goes away on its own.
  if (text.trim() === 'exit now') { notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Bye.' } }); setTimeout(() => process.exit(3), 30); return; }
  // 'quiet:' says nothing at all for a while first, the way claude's empty
  // thinking deltas look to a client, so a test can see the client's own
  // waiting state.
  if (text.startsWith('quiet:')) await sleep(1500);
  notify(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading the request: ' + text } });
  // A prompt starting 'slow:' thinks for a while first, so a test can see the
  // turn in its running state before the permission arrives.
  await sleep(text.startsWith('slow:') ? 1500 : 30);
  for (const chunk of ['Sure. ', 'I will write **greeting.txt** ', 'with a `hello` line.\n\n- one\n- two\n']) {
    if (cancelled) break;
    notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
    await sleep(20);
  }
  if (cancelled) { send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } }); return; }
  const toolCallId = 'tc-' + Date.now().toString(36);
  notify(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'write greeting.txt', kind: 'edit', status: 'pending', rawInput: flavor ? STRING_PATCH : { path: 'greeting.txt' }, locations: [{ path: 'greeting.txt' }] });
  const choice = await askPermission(sessionId, toolCallId, flavor);
  const allowed = choice && choice !== 'reject' && choice !== 'no';
  notify(sessionId, {
    sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed',
    content: allowed ? [{ type: 'diff', path: 'greeting.txt', oldText: null, newText: 'hello from husk\n' }] : [{ type: 'content', content: { type: 'text', text: 'The user rejected the edit.' } }],
  });
  await sleep(20);
  notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? `Done, permission was ${choice}. (model ${lastModel})${imageCount ? ` (images ${imageCount})` : ''}` : 'Understood, I did not write the file.' } });
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
}

function handle(msg) {
  if (msg.id !== undefined && !msg.method) {
    const resolve = waitingPermission.get(msg.id);
    if (resolve) {
      waitingPermission.delete(msg.id);
      const outcome = msg.result && msg.result.outcome;
      resolve(outcome && outcome.outcome === 'selected' ? outcome.optionId : null);
    }
    return;
  }
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '1.0.0' }, agentCapabilities: { loadSession: false }, authMethods: [] } });
      break;
    case 'session/new': {
      const sessionId = 'fake-' + (++sessionCounter);
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId, modes: { availableModes: [{ id: 'default', name: 'Default', description: 'Asks first' }], currentModeId: 'default' }, models: { availableModels: [{ modelId: 'fake-1', name: 'Fake 1' }, { modelId: 'fake-2', name: 'Fake 2', description: 'The other one' }], currentModelId: 'fake-1' } } });
      notify(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help', description: 'Show help' }].concat('abcdefghijkl'.split('').map((ch) => ({ name: ch + 'cmd', description: 'Command ' + ch.toUpperCase() }))) });
      break;
    }
    case 'session/prompt':
      runTurn(msg.id, msg.params || {});
      break;
    case 'session/set_model':
      lastModel = msg.params && msg.params.modelId;
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      break;
    case 'session/cancel':
      cancelled = true;
      break;
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not implemented' } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (_) { /* ignore non-JSON */ }
  }
});
process.stdin.on('end', () => process.exit(0));
