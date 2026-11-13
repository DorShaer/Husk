'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createChatRuntime } = require('../../src/lib/chat-runtime');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdinLines = [];
  child.stdin = { write: (s) => { child.stdinLines.push(JSON.parse(s)); return true; }, end: () => {} };
  child.kill = () => {};
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
    buildEnv: () => ({ PATH: '/bin' }),
    resolveExe: (name) => '/abs/' + name,
    emit: (tabId, ev) => events.push(ev),
    emitExit: (tabId, code) => exits.push(code),
    appVersion: '9.9.9',
    platform: 'win32',
  });
  return { rt, spawned, events, exits, children };
}

function tick() { return new Promise((r) => setImmediate(r)); }
const sent = (c, method) => c.stdinLines.filter((l) => l.method === method);

// Walks the handshake: initialize, model/list, thread/start.
async function started(command = 'codex', { models = { result: { data: [{ id: 'm1', displayName: 'Model One' }] } } } = {}) {
  const h = harness();
  const p = h.rt.start({ tabId: 't1', command, cwd: '/w' });
  await tick();
  const c = h.children[0];
  c.feed({ id: sent(c, 'initialize')[0].id, result: { userAgent: 'x' } });
  await tick();
  c.feed(Object.assign({ id: sent(c, 'model/list')[0].id }, models));
  await tick();
  const request = sent(c, 'thread/resume')[0] || sent(c, 'thread/start')[0];
  c.feed({ id: request.id, result: { thread: { id: request.params.threadId || 'T1' }, model: 'm1' } });
  const res = await p;
  return Object.assign(h, { c, res });
}

test('codex start spawns app-server, handshakes and emits the session', async () => {
  const { spawned, c, res, events } = await started();
  assert.equal(spawned[0].exe, '/abs/codex');
  assert.deepEqual(spawned[0].args, ['app-server']);
  assert.equal(sent(c, 'initialize')[0].params.clientInfo.name, 'husk');
  assert.equal(sent(c, 'initialize')[0].params.clientInfo.version, '9.9.9');
  assert.equal(sent(c, 'initialized').length, 1);
  assert.equal(sent(c, 'thread/start')[0].params.cwd, '/w');
  assert.equal(sent(c, 'thread/start')[0].params.model, undefined);
  assert.deepEqual(res, { ok: true, transport: 'codex', sessionId: 'T1' });
  const session = events.find((e) => e.type === 'session');
  assert.equal(session.sessionId, 'T1');
  assert.equal(session.model, 'Model One');
  assert.equal(session.models.available.length, 1);
});

test('a pinned model rides on thread/start, and a missing model list still starts', async () => {
  const { c, res, events } = await started('codex --model gpt-x', { models: { error: { code: -32601, message: 'no' } } });
  assert.equal(sent(c, 'thread/start')[0].params.model, 'gpt-x');
  assert.equal(res.ok, true);
  assert.equal(events.find((e) => e.type === 'session').models, undefined);
});

test('a prompt starts a turn, streams text and ends', async () => {
  const { rt, c, events } = await started();
  assert.deepEqual(await rt.prompt({ tabId: 't1', text: 'hello' }), { ok: true });
  const turn = sent(c, 'turn/start')[0];
  assert.equal(turn.params.threadId, 'T1');
  assert.deepEqual(turn.params.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  assert.equal(rt.info('t1').turnOpen, true);
  c.feed({ method: 'item/agentMessage/delta', params: { delta: 'hi' } });
  c.feed({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed' } } });
  assert.deepEqual(events.filter((e) => e.type === 'text'), [{ type: 'text', text: 'hi' }]);
  assert.equal(events[events.length - 1].type, 'turn_end');
  assert.equal(rt.info('t1').turnOpen, false);
});

test('an approval request becomes a card and the answer goes back on its id', async () => {
  const { rt, c, events } = await started();
  c.feed({ id: 7, method: 'item/commandExecution/requestApproval', params: { itemId: 'e1', command: 'ls', availableDecisions: ['accept', 'cancel'] } });
  const card = events.find((e) => e.type === 'permission');
  assert.equal(card.title, 'Run command');
  assert.deepEqual(await rt.permission({ tabId: 't1', requestId: card.requestId, optionId: 'accept' }), { ok: true });
  await tick();
  assert.deepEqual(c.stdinLines.find((l) => l.id === 7 && l.result), { jsonrpc: '2.0', id: 7, result: { decision: 'accept' } });
  assert.equal(events[events.length - 1].type, 'permission_resolved');
});

test('a server request Husk has no card for is refused, not left hanging', async () => {
  const { c } = await started();
  c.feed({ id: 9, method: 'item/tool/requestUserInput', params: {} });
  assert.equal(c.stdinLines.find((l) => l.id === 9).error.code, -32601);
});

test('cancel interrupts the live turn and is silent without one', async () => {
  const { rt, c } = await started();
  await rt.cancel({ tabId: 't1' });
  assert.equal(sent(c, 'turn/interrupt').length, 0);
  await rt.prompt({ tabId: 't1', text: 'go' });
  c.feed({ method: 'turn/started', params: { turn: { id: 'u1' } } });
  await rt.cancel({ tabId: 't1' });
  assert.deepEqual(sent(c, 'turn/interrupt')[0].params, { threadId: 'T1', turnId: 'u1' });
});

test('a model switch applies to the next turn only once', async () => {
  const { rt, c, events } = await started();
  assert.deepEqual(await rt.setModel({ tabId: 't1', modelId: 'm2', modelName: 'Model Two' }), { ok: true, transport: 'codex', model: 'm2' });
  assert.deepEqual(events[events.length - 1], { type: 'session', model: 'Model Two' });
  await rt.prompt({ tabId: 't1', text: 'a' });
  c.feed({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await rt.prompt({ tabId: 't1', text: 'b' });
  const turns = sent(c, 'turn/start');
  assert.equal(turns[0].params.model, 'm2');
  assert.equal(turns[1].params.model, undefined);
});

test('the child exiting with a card open reports the exit', async () => {
  const { c, exits, rt } = await started();
  c.feed({ id: 3, method: 'item/fileChange/requestApproval', params: { itemId: 'f1' } });
  c.emit('exit', 1, null);
  assert.deepEqual(exits, [1]);
  assert.equal(rt.info('t1'), null);
});

test('a stop pressed before codex names the turn goes out once it does', async () => {
  const { rt, c } = await started();
  await rt.prompt({ tabId: 't1', text: 'go' });
  await rt.cancel({ tabId: 't1' });
  assert.equal(sent(c, 'turn/interrupt').length, 0);
  c.feed({ id: sent(c, 'turn/start')[0].id, result: { turn: { id: 'u7' } } });
  await tick();
  c.feed({ method: 'turn/started', params: { turn: { id: 'u7' } } });
  assert.deepEqual(sent(c, 'turn/interrupt').map((l) => l.params.turnId), ['u7']);
});

test('recalled context rides ahead of the prompt on the wire and stays out of the log', async () => {
  const { rt, c } = await started();
  await rt.prompt({ tabId: 't1', text: 'hello', context: '[notes]' });
  assert.equal(sent(c, 'turn/start')[0].params.input[0].text, '[notes]\n\nhello');
  const logged = rt.list()[0].events.find((e) => e.type === 'user');
  assert.equal(logged.text, 'hello');
});

test('Allow all accepts this codex approval and the ones after it, one accept each', async () => {
  const { rt, c, events } = await started();
  c.feed({ id: 7, method: 'item/commandExecution/requestApproval', params: { itemId: 'e1', command: 'ls', availableDecisions: ['accept', 'acceptForSession', 'cancel'] } });
  const card = events.find((e) => e.type === 'permission');
  assert.deepEqual(card.options.map((o) => o.optionId), ['accept', 'acceptForSession', 'allow-all', 'decline']);
  assert.deepEqual(await rt.permission({ tabId: 't1', requestId: card.requestId, optionId: 'allow-all' }), { ok: true });
  await tick();
  assert.deepEqual(c.stdinLines.find((l) => l.id === 7 && l.result).result, { decision: 'accept' });
  // A different command and a file change: no click, same answer.
  c.feed({ id: 8, method: 'item/commandExecution/requestApproval', params: { itemId: 'e2', command: 'rm -rf build' } });
  c.feed({ id: 9, method: 'item/fileChange/requestApproval', params: { itemId: 'e3' } });
  await tick();
  assert.deepEqual(c.stdinLines.find((l) => l.id === 8 && l.result).result, { decision: 'accept' });
  assert.deepEqual(c.stdinLines.find((l) => l.id === 9 && l.result).result, { decision: 'accept' });
  assert.equal(events.filter((e) => e.type === 'permission_resolved').length, 3);
});


test('codex resume continues the saved thread and sends follow-ups to its id', async () => {
  const id = '01a1d208-8467-7c32-8e5a-27d5e8d10a95';
  const { rt, c, res, events } = await started(`codex resume ${id}`);
  assert.equal(sent(c, 'thread/start').length, 0);
  assert.deepEqual(sent(c, 'thread/resume')[0].params, { cwd: '/w', threadId: id, excludeTurns: true });
  assert.equal(res.sessionId, id);
  assert.equal(events.find((e) => e.type === 'session').sessionId, id);
  await rt.prompt({ tabId: 't1', text: 'continue' });
  assert.equal(sent(c, 'turn/start')[0].params.threadId, id);
});
