#!/usr/bin/env node
'use strict';

// A deterministic `codex app-server` for Chat-mode e2e. Speaks the newline
// JSON-RPC the real one does and plays one fixed turn per prompt: streamed
// text, a shell command that asks for approval, a token reading, a closing
// line that echoes the approval so a test can assert on the client's choice,
// and whether the prompt arrived carrying notes from Husk's Brain.

// The non-interactive listing Husk runs for /mcp typed in a chat.
if (process.argv[2] === 'mcp' && process.argv[3] === 'list') { process.stdout.write('Name     Command  Status\nfixture  node     enabled\n'); process.exit(0); }
if (process.argv[2] !== 'app-server') {
  if (process.env.HUSK_CANVAS_TERMINAL === '1' && !['--version', '-v'].includes(process.argv[2])) {
    const fs = require('node:fs');
    process.stdout.write('Codex terminal ready\r\n');
    process.stdin.on('data', (chunk) => {
      try { fs.appendFileSync(process.env.HUSK_CANVAS_TERMINAL_LOG, chunk); } catch (_) {}
    });
  } else {
    process.stdout.write('fake codex 0.0.1\n');
    process.exit(0);
  }
}

let THREAD = 'thread-0001';
let buf = '';
let turnSeq = 0;
let serverReq = 0;
const waiting = new Map();

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function note(method, params) { send({ method, params }); }

function ask(method, params) {
  const id = ++serverReq;
  return new Promise((resolve) => { waiting.set(id, resolve); send({ id, method, params }); });
}

async function playTurn(turnId, prompt) {
  note('turn/started', { threadId: THREAD, turn: { id: turnId, status: 'inProgress' } });
  note('item/started', { threadId: THREAD, turnId, item: { type: 'agentMessage', id: 'm1', text: '' } });
  for (const delta of ['Running ', 'the **command**.']) note('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: 'm1', delta });
  note('item/completed', { threadId: THREAD, turnId, item: { type: 'agentMessage', id: 'm1', text: 'Running the **command**.' } });
  const demo = process.env.HUSK_CANVAS_DEMO === '1';
  const command = demo ? 'git diff -- retry.js' : "/bin/sh -lc 'echo hi'";
  const exec = { type: 'commandExecution', id: 'exec-1', command, cwd: process.cwd(), commandActions: [{ type: 'unknown', command }] };
  note('item/started', { threadId: THREAD, turnId, item: { ...exec, status: 'inProgress' } });
  const answer = await ask('item/commandExecution/requestApproval', {
    threadId: THREAD, turnId, itemId: 'exec-1', command: exec.command, cwd: exec.cwd, commandActions: exec.commandActions,
    reason: demo ? 'Show the working-tree diff?' : 'Allow the echo?', availableDecisions: ['accept', 'cancel'],
  });
  const ok = answer && answer.decision === 'accept';
  note('item/completed', { threadId: THREAD, turnId, item: { ...exec, status: ok ? 'completed' : 'declined', exitCode: ok ? 0 : null, aggregatedOutput: ok ? 'hi\n' : null } });
  note('thread/tokenUsage/updated', { threadId: THREAD, turnId, tokenUsage: { total: { totalTokens: 20000 }, last: { totalTokens: 20000 }, modelContextWindow: 200000 } });
  note('item/started', { threadId: THREAD, turnId, item: { type: 'agentMessage', id: 'm2', text: '' } });
  const closing = process.env.HUSK_E2E_REPLY || `decision was ${answer && answer.decision} brain=${/Husk Brain/.test(prompt) ? 'yes' : 'no'}`;
  note('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: 'm2', delta: closing });
  note('item/completed', { threadId: THREAD, turnId, item: { type: 'agentMessage', id: 'm2', text: closing } });
  note('turn/completed', { threadId: THREAD, turn: { id: turnId, status: 'completed', error: null, durationMs: 1200 } });
}

function handle(msg) {
  if (msg.id !== undefined && !msg.method) {
    const done = waiting.get(msg.id);
    if (done) { waiting.delete(msg.id); done(msg.result); }
    return;
  }
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize': send({ id: msg.id, result: { userAgent: 'fake-codex', codexHome: '/tmp' } }); break;
    case 'model/list': send({ id: msg.id, result: { data: [{ id: 'gpt-fake', displayName: 'GPT Fake', description: 'The fixture model.', hidden: false, isDefault: true }], nextCursor: null } }); break;
    case 'thread/resume':
      THREAD = msg.params.threadId;
      send({ id: msg.id, result: { thread: { id: THREAD }, model: 'gpt-fake' } });
      break;
    case 'thread/start': send({ id: msg.id, result: { thread: { id: THREAD }, model: (msg.params && msg.params.model) || 'gpt-fake' } }); break;
    case 'turn/start': {
      const turnId = 'turn-' + (++turnSeq);
      send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      playTurn(turnId, ((msg.params && msg.params.input) || []).map((i) => i.text || '').join(' '));
      break;
    }
    default: send({ id: msg.id, error: { code: -32601, message: 'unknown method ' + msg.method } });
  }
}

process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) { try { handle(JSON.parse(line)); } catch (_) { /* a bad line is ignored, as the real one does */ } }
  }
});
process.stdin.on('end', () => process.exit(0));
