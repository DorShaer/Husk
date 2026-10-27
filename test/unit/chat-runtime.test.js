'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createChatRuntime } = require('../../src/lib/chat-runtime');

// A fake child: records stdin lines, lets the test feed stdout lines.
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdinLines = [];
  child.stdin = {
    write: (s) => { child.stdinLines.push(JSON.parse(s)); return true; },
    end: () => { child.stdinEnded = true; },
  };
  child.killed = [];
  child.kill = (sig) => { child.killed.push(sig || 'SIGTERM'); };
  child.feed = (obj) => child.stdout.emit('data', JSON.stringify(obj) + '\n');
  return child;
}

function harness() {
  const spawned = [];
  const events = [];
  const exits = [];
  const children = [];
  const rt = createChatRuntime({
    spawn: (exe, args, opts) => { const c = fakeChild(); spawned.push({ exe, args, opts }); children.push(c); return c; },
    buildEnv: () => ({ PATH: '/bin', HUSK_HOST: '1' }),
    resolveExe: (name) => '/abs/' + name,
    emit: (tabId, ev) => events.push({ tabId, ev }),
    emitExit: (tabId, code) => exits.push({ tabId, code }),
    appVersion: '2.12.0',
    platform: 'win32',
    controlTimeoutMs: 50,
  });
  return { rt, spawned, events, exits, children };
}

function tick() { return new Promise((r) => setImmediate(r)); }

test('start refuses a CLI without a protocol', async () => {
  const { rt, spawned } = harness();
  const r = await rt.start({ tabId: 't1', command: 'aider', cwd: '/w' });
  assert.equal(r.ok, false);
  assert.match(r.error, /aider/);
  assert.equal(spawned.length, 0);
});

test('acp start handshakes, creates a session and emits the session event', async () => {
  const { rt, spawned, events, children } = harness();
  const p = rt.start({ tabId: 't1', command: 'gemini --model m', cwd: '/w' });
  await tick();
  assert.equal(spawned[0].exe, '/abs/gemini');
  assert.deepEqual(spawned[0].args, ['--acp', '--model', 'm']);
  assert.equal(spawned[0].opts.cwd, '/w');
  assert.equal(spawned[0].opts.env.HUSK_HOST, '1');
  const c = children[0];
  assert.equal(c.stdinLines[0].method, 'initialize');
  assert.equal(c.stdinLines[0].params.clientInfo.version, '2.12.0');
  c.feed({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
  await tick();
  assert.equal(c.stdinLines[1].method, 'session/new');
  assert.equal(c.stdinLines[1].params.cwd, '/w');
  c.feed({ jsonrpc: '2.0', id: 2, result: { sessionId: 'S1', modes: { availableModes: [], currentModeId: 'default' } } });
  const r = await p;
  assert.deepEqual(r, { ok: true, transport: 'acp', sessionId: 'S1' });
  assert.equal(events[0].ev.type, 'session');
  assert.equal(events[0].ev.sessionId, 'S1');
  assert.deepEqual(rt.info('t1'), { transport: 'acp', sessionId: 'S1', pid: 4242, turnOpen: false });
});

async function startedAcp() {
  const h = harness();
  const p = h.rt.start({ tabId: 't1', command: 'copilot', cwd: '/w' });
  await tick();
  const c = h.children[0];
  c.feed({ jsonrpc: '2.0', id: 1, result: {} });
  await tick();
  c.feed({ jsonrpc: '2.0', id: 2, result: { sessionId: 'S1' } });
  await p;
  h.events.length = 0;
  return Object.assign(h, { c });
}

test('acp prompt streams updates, answers permission, and ends the turn', async () => {
  const h = await startedAcp();
  const { rt, c, events } = h;
  assert.deepEqual(await rt.prompt({ tabId: 't1', text: 'do it' }), { ok: true });
  assert.equal(events[0].ev.type, 'turn_start');
  const promptLine = c.stdinLines[c.stdinLines.length - 1];
  assert.equal(promptLine.method, 'session/prompt');
  assert.deepEqual(promptLine.params.prompt, [{ type: 'text', text: 'do it' }]);

  c.feed({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Sure' } } } });
  c.feed({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'rm x', status: 'pending', kind: 'execute' } } });
  c.feed({ jsonrpc: '2.0', id: 'srv-1', method: 'session/request_permission', params: { sessionId: 'S1', toolCall: { toolCallId: 'tc1', title: 'rm x' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] } });
  await tick();
  const perm = events.find((e) => e.ev.type === 'permission');
  assert.ok(perm);
  assert.equal(perm.ev.title, 'rm x');
  assert.equal(perm.ev.options.length, 2);

  assert.deepEqual(await rt.permission({ tabId: 't1', requestId: perm.ev.requestId, optionId: 'allow' }), { ok: true });
  await tick();
  const reply = c.stdinLines.find((l) => l.id === 'srv-1');
  assert.deepEqual(reply.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
  assert.ok(events.some((e) => e.ev.type === 'permission_resolved' && e.ev.optionId === 'allow'));

  c.feed({ jsonrpc: '2.0', id: promptLine.id, result: { stopReason: 'end_turn' } });
  await tick();
  const end = events[events.length - 1].ev;
  assert.equal(end.type, 'turn_end');
  assert.equal(end.stopReason, 'end_turn');
  assert.equal(rt.info('t1').turnOpen, false);
});

test('acp cancel sends session/cancel and an unknown permission id is refused', async () => {
  const h = await startedAcp();
  await h.rt.cancel({ tabId: 't1' });
  const last = h.c.stdinLines[h.c.stdinLines.length - 1];
  assert.equal(last.method, 'session/cancel');
  assert.equal(last.id, undefined);
  const r = await h.rt.permission({ tabId: 't1', requestId: 'nope', optionId: 'allow' });
  assert.equal(r.ok, false);
});

test('acp handshake failure stops the child and surfaces stderr', async () => {
  const { rt, children } = harness();
  const p = rt.start({ tabId: 't1', command: 'gemini', cwd: '/w' });
  await tick();
  const c = children[0];
  c.stderr.emit('data', 'Error: not logged in\n');
  c.feed({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'auth required' } });
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /not logged in/);
  assert.equal(rt.size(), 0);
  assert.ok(c.stdinEnded);
  assert.ok(c.killed.length >= 1);
});

test('claude start spawns stream-json argv and prompt writes a user line', async () => {
  const { rt, spawned, children, events } = harness();
  const r = await rt.start({ tabId: 't2', command: 'claude --model opus', cwd: '/w' });
  assert.deepEqual(r, { ok: true, transport: 'claude', sessionId: null });
  const pinned = await rt.start({ tabId: 't3', command: 'claude', cwd: '/w', claudeSessionId: 'abc-123' });
  assert.equal(pinned.sessionId, 'abc-123');
  assert.deepEqual(spawned[1].args.slice(-2), ['--session-id', 'abc-123']);
  const userPinned = await rt.start({ tabId: 't4', command: 'claude --resume zzz', cwd: '/w', claudeSessionId: 'abc-123' });
  assert.equal(userPinned.sessionId, null);
  assert.ok(!spawned[2].args.includes('abc-123'));
  assert.equal(spawned[0].exe, '/abs/claude');
  assert.deepEqual(spawned[0].args.slice(0, 2), ['-p', '--input-format']);
  assert.deepEqual(spawned[0].args.slice(-2), ['--model', 'opus']);
  const c = children[0];
  assert.deepEqual(await rt.prompt({ tabId: 't2', text: 'hi' }), { ok: true });
  assert.equal(c.stdinLines[0].type, 'control_request');
  assert.equal(c.stdinLines[0].request.subtype, 'initialize');
  assert.deepEqual(c.stdinLines[1], { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });

  c.feed({ type: 'system', subtype: 'init', session_id: 'sid-1', model: 'claude-x' });
  c.feed({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
  assert.equal(rt.info('t2').sessionId, 'sid-1');
  assert.equal(events[1].ev.type, 'text');
});

test('claude permission round-trips the captured input and clears on result', async () => {
  const { rt, children, events } = harness();
  await rt.start({ tabId: 't2', command: 'claude', cwd: '/w' });
  const c = children[0];
  await rt.prompt({ tabId: 't2', text: 'mkdir' });
  c.feed({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'mkdir x' }, tool_use_id: 'tu1' } });
  const perm = events.find((e) => e.ev.type === 'permission');
  assert.equal(perm.ev.requestId, 'req-1');
  assert.equal(perm.ev.detail, 'mkdir x');

  await rt.permission({ tabId: 't2', requestId: 'req-1', optionId: 'deny' });
  const resp = c.stdinLines[c.stdinLines.length - 1];
  assert.equal(resp.type, 'control_response');
  assert.equal(resp.response.request_id, 'req-1');
  assert.equal(resp.response.response.behavior, 'deny');
  assert.equal((await rt.permission({ tabId: 't2', requestId: 'req-1', optionId: 'allow' })).ok, false);

  c.feed({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5 });
  assert.equal(rt.info('t2').turnOpen, false);
  assert.equal(events[events.length - 1].ev.type, 'turn_end');
});

test('claude cancel writes an interrupt control request', async () => {
  const { rt, children } = harness();
  await rt.start({ tabId: 't2', command: 'claude', cwd: '/w' });
  await rt.cancel({ tabId: 't2' });
  const last = children[0].stdinLines[children[0].stdinLines.length - 1];
  assert.equal(last.type, 'control_request');
  assert.equal(last.request.subtype, 'interrupt');
});

test('child exit reports chat:exit, surfaces stderr on failure, and frees the slot', async () => {
  const { rt, children, events, exits } = harness();
  await rt.start({ tabId: 't2', command: 'claude', cwd: '/w' });
  const c = children[0];
  c.stderr.emit('data', 'Not logged in. Run claude login.\n');
  c.emit('exit', 1, null);
  assert.deepEqual(exits, [{ tabId: 't2', code: 1 }]);
  assert.ok(events.some((e) => e.ev.type === 'error' && /Not logged in/.test(e.ev.text)));
  assert.equal(rt.size(), 0);
  assert.equal((await rt.prompt({ tabId: 't2', text: 'x' })).ok, false);
});

test('stop ends stdin, kills the child, and restarting a tab replaces the old child', async () => {
  const { rt, children } = harness();
  await rt.start({ tabId: 't2', command: 'claude', cwd: '/w' });
  await rt.start({ tabId: 't2', command: 'claude', cwd: '/w' });
  assert.equal(children.length, 2);
  assert.ok(children[0].stdinEnded);
  assert.ok(children[0].killed.length >= 1);
  assert.equal(rt.size(), 1);
  await rt.stop({ tabId: 't2' });
  assert.equal(rt.size(), 0);
  assert.ok(children[1].stdinEnded);
  rt.stopAll();
});

test('list replays a reloaded tab: user line, coalesced text, tool and permission events, command and cwd', async () => {
  const h = await startedAcp();
  const { rt, c } = h;
  await rt.prompt({ tabId: 't1', text: 'do it' });
  c.feed({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Su' } } } });
  c.feed({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 're' } } } });
  c.feed({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'ls', status: 'pending', kind: 'execute' } } });
  c.feed({ jsonrpc: '2.0', id: 'srv-1', method: 'session/request_permission', params: { sessionId: 'S1', toolCall: { toolCallId: 'tc1', title: 'ls' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } });
  await tick();
  const perm = h.events.find((e) => e.ev.type === 'permission');
  await rt.permission({ tabId: 't1', requestId: perm.ev.requestId, optionId: 'allow' });
  const list = rt.list();
  assert.equal(list.length, 1);
  const s = list[0];
  assert.equal(s.tabId, 't1');
  assert.equal(s.transport, 'acp');
  assert.equal(s.sessionId, 'S1');
  assert.equal(s.command, 'copilot');
  assert.equal(s.cwd, '/w');
  assert.equal(s.turnOpen, true);
  const types = s.events.map((e) => e.type);
  assert.deepEqual(types, ['session', 'user', 'turn_start', 'text', 'tool', 'permission', 'permission_resolved']);
  assert.equal(s.events[3].text, 'Sure');
  // The log is a copy: mutating it does not touch the runtime's own record.
  s.events[3].text = 'x';
  assert.equal(rt.list()[0].events[3].text, 'Sure');
  c.feed({ jsonrpc: '2.0', id: c.stdinLines.find((l) => l.method === 'session/prompt').id, result: { stopReason: 'end_turn' } });
  await tick();
  assert.equal(rt.list()[0].turnOpen, false);
  assert.equal(rt.list()[0].events.pop().type, 'turn_end');
});

test('a stopped or exited child leaves the list', async () => {
  const h = await startedAcp();
  assert.equal(h.rt.list().length, 1);
  h.c.emit('exit', 0, null);
  assert.equal(h.rt.list().length, 0);
});

test('claude allow-session hands the permission suggestions back as updatedPermissions', async () => {
  const { rt, children, events } = harness();
  await rt.start({ tabId: 't2', command: 'claude', cwd: '/w' });
  const c = children[0];
  const suggestions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
  c.feed({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/w/a.txt', content: 'x' }, permission_suggestions: suggestions } });
  const perm = events.find((e) => e.ev.type === 'permission');
  assert.deepEqual(perm.ev.options.map((o) => o.optionId), ['allow', 'allow-session', 'deny']);
  await rt.permission({ tabId: 't2', requestId: 'req-1', optionId: 'allow-session' });
  const resp = c.stdinLines[c.stdinLines.length - 1].response.response;
  assert.equal(resp.behavior, 'allow');
  assert.deepEqual(resp.updatedInput, { file_path: '/w/a.txt', content: 'x' });
  assert.deepEqual(resp.updatedPermissions, suggestions);

  c.feed({ type: 'control_request', request_id: 'req-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  const perm2 = events.filter((e) => e.ev.type === 'permission')[1];
  assert.deepEqual(perm2.ev.options.map((o) => o.optionId), ['allow', 'deny']);
  await rt.permission({ tabId: 't2', requestId: 'req-2', optionId: 'allow' });
  assert.equal(c.stdinLines[c.stdinLines.length - 1].response.response.updatedPermissions, undefined);
});

test('an ACP handshake refused for auth points the user at Terminal mode', async () => {
  const { rt, children } = harness();
  const p = rt.start({ tabId: 't1', command: 'copilot', cwd: '/w' });
  await tick();
  children[0].feed({ jsonrpc: '2.0', id: 1, result: {} });
  await tick();
  children[0].feed({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Authentication required' } });
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /Authentication required/);
  assert.match(r.error, /Terminal mode to sign in/);
});

test('on Windows a .cmd shim runs through the command interpreter', async () => {
  const spawned = [];
  const rt = createChatRuntime({
    spawn: (exe, args, opts) => { spawned.push({ exe, args, opts }); return fakeChild(); },
    buildEnv: () => ({ PATH: 'C:\\bin', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }),
    resolveExe: () => 'C:\\Users\\d\\AppData\\Roaming\\npm\\claude.cmd',
    emit: () => {}, emitExit: () => {}, platform: 'win32',
  });
  await rt.start({ tabId: 'w', command: 'claude --model opus', cwd: 'C:\\proj' });
  assert.equal(spawned[0].exe, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(spawned[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(spawned[0].args[3], /^"C:\\Users\\d\\AppData\\Roaming\\npm\\claude\.cmd -p --input-format stream-json .* --model opus"$/);
  assert.equal(spawned[0].opts.windowsVerbatimArguments, true);
  assert.equal(spawned[0].opts.detached, false);
  const plain = [];
  const rt2 = createChatRuntime({ spawn: (exe, args, opts) => { plain.push({ exe, args, opts }); return fakeChild(); }, resolveExe: () => 'C:\\tools\\claude.exe', emit: () => {}, emitExit: () => {}, platform: 'win32' });
  await rt2.start({ tabId: 'w', command: 'claude', cwd: 'C:\\proj' });
  assert.equal(plain[0].exe, 'C:\\tools\\claude.exe');
});

test('an ACP agent that never answers initialize fails the start instead of hanging', async () => {
  const spawned = [];
  const children = [];
  const rt = createChatRuntime({
    spawn: (exe, args, opts) => { const c = fakeChild(); spawned.push({ exe, args, opts }); children.push(c); return c; },
    resolveExe: (n) => '/abs/' + n, emit: () => {}, emitExit: () => {}, platform: 'win32', handshakeMs: 30,
  });
  const r = await rt.start({ tabId: 't1', command: 'copilot', cwd: '/w' });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not answer the ACP handshake/);
  assert.match(r.error, /--acp/);
  assert.equal(rt.size(), 0);
  assert.ok(children[0].stdinEnded);
  assert.ok(children[0].killed.length >= 1);
});

test('setModel on an ACP tab calls session/set_model and reports the new model', async () => {
  const h = await startedAcp();
  const p = h.rt.setModel({ tabId: 't1', modelId: 'gemini-2.5-pro', modelName: 'gemini-2.5-pro' });
  await tick();
  const req = h.c.stdinLines[h.c.stdinLines.length - 1];
  assert.equal(req.method, 'session/set_model');
  assert.deepEqual(req.params, { sessionId: 'S1', modelId: 'gemini-2.5-pro' });
  h.c.feed({ jsonrpc: '2.0', id: req.id, result: {} });
  const r = await p;
  assert.deepEqual(r, { ok: true, transport: 'acp', model: 'gemini-2.5-pro' });
  assert.equal(h.events[h.events.length - 1].ev.type, 'session');
  assert.equal(h.events[h.events.length - 1].ev.model, 'gemini-2.5-pro');
  const bad = h.rt.setModel({ tabId: 't1', modelId: 'nope' });
  await tick();
  h.c.feed({ jsonrpc: '2.0', id: h.c.stdinLines[h.c.stdinLines.length - 1].id, error: { code: -32602, message: 'unknown model' } });
  assert.equal((await bad).ok, false);
});

test('setModel on a claude tab that never answers set_model falls back to a restart with --model and --resume', async () => {
  const { rt, spawned, children, events } = harness();
  await rt.start({ tabId: 't2', command: 'claude --model opus', cwd: '/w', claudeSessionId: 'sid-9' });
  await rt.prompt({ tabId: 't2', text: 'hello' });
  children[0].feed({ type: 'result', subtype: 'success', is_error: false });
  const before = rt.list()[0].events.length;
  const r = await rt.setModel({ tabId: 't2', modelId: 'claude-sonnet-5', modelName: 'Sonnet 5' });
  assert.deepEqual(r, { ok: true, transport: 'claude', model: 'claude-sonnet-5', restarted: true });
  assert.equal(spawned.length, 2);
  const args = spawned[1].args;
  assert.deepEqual(args.slice(-4), ['--model', 'claude-sonnet-5', '--resume', 'sid-9']);
  assert.ok(!args.includes('opus'));
  assert.ok(children[0].stdinEnded);
  const after = rt.list()[0];
  assert.equal(after.sessionId, 'sid-9');
  assert.equal(after.events.length, before + 1);
  assert.equal(events[events.length - 1].ev.model, 'Sonnet 5');
  await rt.prompt({ tabId: 't2', text: 'busy' });
  assert.equal((await rt.setModel({ tabId: 't2', modelId: 'x' })).ok, false);
});

test('prompt sends pasted images on both wires and logs only their kinds', async () => {
  const h = await startedAcp();
  await h.rt.prompt({ tabId: 't1', text: 'what is this', images: [{ mimeType: 'image/png', data: 'QUJD' }, { mimeType: 'text/plain', data: 'nope' }, { data: '' }] });
  const line = h.c.stdinLines[h.c.stdinLines.length - 1];
  assert.equal(line.method, 'session/prompt');
  assert.deepEqual(line.params.prompt, [{ type: 'text', text: 'what is this' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }, { type: 'image', data: 'nope', mimeType: 'image/png' }]);
  const logged = h.rt.list()[0].events.find((e) => e.type === 'user');
  assert.deepEqual(logged.images, [{ mimeType: 'image/png' }, { mimeType: 'image/png' }]);
  assert.equal(JSON.stringify(logged).includes('QUJD'), false);

  const { rt, children } = harness();
  await rt.start({ tabId: 't2', command: 'claude', cwd: '/w' });
  assert.deepEqual(await rt.prompt({ tabId: 't2', text: '', images: [{ mimeType: 'image/jpeg', data: 'QUJD' }] }), { ok: true });
  const c = children[0];
  const msg = c.stdinLines[c.stdinLines.length - 1];
  assert.deepEqual(msg.message.content, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }]);
  assert.equal((await rt.prompt({ tabId: 't2', text: '', images: [] })).ok, false);
});

test('claude: initialize lists the CLI models, set_model switches live with no restart, and a stopped child exits quietly', async () => {
  const { rt, spawned, children, events, exits } = harness();
  await rt.start({ tabId: 'c', command: 'claude', cwd: '/w' });
  const c = children[0];
  const init = c.stdinLines.find((l) => l.type === 'control_request' && l.request.subtype === 'initialize');
  c.feed({ type: 'control_response', response: { subtype: 'success', request_id: init.request_id, response: { models: [{ value: 'default', displayName: 'Default (recommended)' }, { value: 'opus', displayName: 'Opus 5.5', description: 'Big' }, { value: 'claude-opus-4-8', displayName: 'Opus 4.8' }] } } });
  const s = events.find((e) => e.ev.type === 'session' && e.ev.models);
  assert.deepEqual(s.ev.models.available.map((m) => m.id), ['default', 'opus', 'claude-opus-4-8']);
  assert.equal(s.ev.models.available[1].description, 'Big');

  const p = rt.setModel({ tabId: 'c', modelId: 'haiku', modelName: 'Haiku 5.5' });
  await tick();
  const req = c.stdinLines[c.stdinLines.length - 1];
  assert.equal(req.type, 'control_request');
  assert.deepEqual(req.request, { subtype: 'set_model', model: 'haiku' });
  c.feed({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { model: 'claude-haiku-5-5' } } });
  assert.deepEqual(await p, { ok: true, transport: 'claude', model: 'claude-haiku-5-5' });
  assert.equal(spawned.length, 1);
  assert.equal(events[events.length - 1].ev.model, 'Haiku 5.5');

  const bad = rt.setModel({ tabId: 'c', modelId: 'nope' });
  await tick();
  const req2 = c.stdinLines[c.stdinLines.length - 1];
  c.feed({ type: 'control_response', response: { subtype: 'error', request_id: req2.request_id, error: 'unknown model nope' } });
  assert.deepEqual(await bad, { ok: false, error: 'unknown model nope' });

  await rt.stop({ tabId: 'c' });
  c.emit('exit', 0, null);
  assert.deepEqual(exits, []);
});
