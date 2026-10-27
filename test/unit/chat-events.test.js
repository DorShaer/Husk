'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeAcpUpdate, normalizeAcpPermission, normalizeAcpSession,
  normalizeClaudeEvent, emptyThread, reduceThread,
} = require('../../src/lib/chat-events');

function fold(events, start) {
  return events.reduce((s, e) => reduceThread(s, e), start || emptyThread());
}

// ─── ACP normalizer (shapes captured from gemini --acp 0.60.0) ───────────────

test('acp message and thought chunks become text and thought events', () => {
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The output' } }), [{ type: 'text', text: 'The output' }]);
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }), [{ type: 'thought', text: 'hmm' }]);
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' } }), []);
});

test('acp tool_call and tool_call_update map status, content and diffs', () => {
  const call = normalizeAcpUpdate({
    sessionUpdate: 'tool_call', toolCallId: 'run_shell_command__call_1', status: 'in_progress', title: 'echo hello-husk',
    content: [{ type: 'content', content: { type: 'text', text: '(Echoes hello-husk to stdout)' } }], locations: [], kind: 'execute',
  });
  assert.deepEqual(call, [{ type: 'tool', id: 'run_shell_command__call_1', title: 'echo hello-husk', kind: 'execute', status: 'running', output: '(Echoes hello-husk to stdout)' }]);

  const upd = normalizeAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'run_shell_command__call_1', status: 'completed', title: 'echo hello-husk', content: [], locations: [], kind: 'execute' });
  assert.equal(upd[0].status, 'done');
  assert.equal(upd[0].output, undefined);

  const diff = normalizeAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'failed', content: [{ type: 'diff', path: '/p/a.js', oldText: 'a', newText: 'b' }], locations: [{ path: '/p/a.js' }] });
  assert.equal(diff[0].status, 'error');
  assert.deepEqual(diff[0].diffs, [{ path: '/p/a.js', oldText: 'a', newText: 'b' }]);
  assert.deepEqual(diff[0].locations, ['/p/a.js']);
  assert.equal(diff[0].detail, '/p/a.js');
});

test('acp plan, commands and mode updates', () => {
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending', priority: 'high' }] }), [{ type: 'plan', entries: [{ content: 'step', status: 'pending', priority: 'high' }] }]);
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'memory', description: 'Manage memory.' }] }), [{ type: 'commands', commands: [{ name: 'memory', description: 'Manage memory.' }] }]);
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'yolo' }), [{ type: 'mode', modeId: 'yolo' }]);
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'something_new' }), []);
  assert.deepEqual(normalizeAcpUpdate(null), []);
});

test('acp permission request and session result normalize', () => {
  const p = normalizeAcpPermission(5, { toolCall: { toolCallId: 't1', title: 'rm build', rawInput: { command: 'rm -rf build' } }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
  assert.equal(p.type, 'permission');
  assert.equal(p.requestId, '5');
  assert.equal(p.title, 'rm build');
  assert.deepEqual(p.options, [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]);

  const s = normalizeAcpSession({ sessionId: 'abc', modes: { availableModes: [{ id: 'default', name: 'Default', description: 'Prompts' }], currentModeId: 'default' }, models: { availableModels: [{ modelId: 'auto', name: 'Auto' }], currentModelId: 'auto' } });
  assert.equal(s.sessionId, 'abc');
  assert.equal(s.model, 'Auto');
  assert.equal(s.modes.current, 'default');
});

// ─── claude normalizer (shapes captured from claude stream-json live) ────────

test('claude init, deltas, tool_use, tool_result, permission and result', () => {
  assert.deepEqual(normalizeClaudeEvent({ type: 'system', subtype: 'init', session_id: 'sid', model: 'claude-x', slash_commands: ['compact'] }), [{ type: 'session', sessionId: 'sid', model: 'claude-x', commands: [{ name: 'compact', description: '' }] }]);
  assert.deepEqual(normalizeClaudeEvent({ type: 'stream_event', event: { type: 'message_start' } }), [{ type: 'turn_start' }]);
  assert.deepEqual(normalizeClaudeEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Writ' } } }), [{ type: 'text', text: 'Writ' }]);
  assert.deepEqual(normalizeClaudeEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } } }), []);
  assert.deepEqual(normalizeClaudeEvent({ type: 'stream_event', event: { type: 'content_block_stop' } }), [{ type: 'block_end' }]);

  const tu = normalizeClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Writing note.txt now.' }, { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/p/note.txt', content: 'hello' } }] } });
  assert.deepEqual(tu[0], { type: 'text_final', text: 'Writing note.txt now.' });
  assert.equal(tu[1].type, 'tool');
  assert.equal(tu[1].id, 'toolu_1');
  assert.equal(tu[1].title, 'Write');
  assert.equal(tu[1].kind, 'edit');
  assert.equal(tu[1].detail, '/p/note.txt');

  const tr = normalizeClaudeEvent({ type: 'user', message: { content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'File created successfully' }] } });
  assert.deepEqual(tr, [{ type: 'tool', id: 'toolu_1', status: 'done', output: 'File created successfully' }]);
  const terr = normalizeClaudeEvent({ type: 'user', message: { content: [{ tool_use_id: 'toolu_2', type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } });
  assert.equal(terr[0].status, 'error');
  assert.equal(terr[0].output, 'boom');

  const perm = normalizeClaudeEvent({ type: 'control_request', request_id: 'r9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'mkdir probe-dir' }, tool_use_id: 'toolu_3' } });
  assert.equal(perm[0].type, 'permission');
  assert.equal(perm[0].requestId, 'r9');
  assert.equal(perm[0].title, 'Bash');
  assert.equal(perm[0].detail, 'mkdir probe-dir');
  assert.deepEqual(perm[0].options.map((o) => o.optionId), ['allow', 'deny']);
  assert.deepEqual(normalizeClaudeEvent({ type: 'control_request', request_id: 'r1', request: { subtype: 'initialize' } }), []);

  const res = normalizeClaudeEvent({ type: 'result', subtype: 'success', stop_reason: 'end_turn', duration_ms: 1200, total_cost_usd: 0.01, is_error: false });
  assert.equal(res[0].type, 'turn_end');
  assert.equal(res[0].stopReason, 'end_turn');
  assert.equal(res[0].durationMs, 1200);
  assert.deepEqual(normalizeClaudeEvent({ type: 'rate_limit_event' }), []);
});

// ─── reducer ─────────────────────────────────────────────────────────────────

test('text chunks append to one open block and close on block_end', () => {
  const s = fold([
    { type: 'user', text: 'hi' },
    { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' },
    { type: 'block_end' },
    { type: 'text', text: 'again' },
  ]);
  assert.equal(s.items.length, 3);
  assert.deepEqual(s.items[0].kind, 'user');
  assert.equal(s.items[1].text, 'Hello');
  assert.equal(s.items[1].open, false);
  assert.equal(s.items[2].text, 'again');
  assert.equal(s.items[2].open, true);
  assert.equal(s.turnOpen, true);
});

test('text_final replaces the streamed block instead of duplicating it', () => {
  const s = fold([{ type: 'text', text: 'Writ' }, { type: 'text', text: 'ing' }, { type: 'block_end' }, { type: 'text_final', text: 'Writing note.txt now.' }]);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].text, 'Writing note.txt now.');
  const t = fold([{ type: 'text_final', text: 'only final' }]);
  assert.equal(t.items.length, 1);
  assert.equal(t.items[0].text, 'only final');
  const u = fold([{ type: 'text_final', text: 'a' }, { type: 'text_final', text: 'b' }]);
  assert.equal(u.items.length, 2);
});

test('tool events upsert a card by id and never mutate prior state', () => {
  const s1 = fold([{ type: 'tool', id: 't1', title: 'Bash', kind: 'execute', status: 'running', detail: 'ls' }]);
  const s2 = reduceThread(s1, { type: 'tool', id: 't1', status: 'done', output: 'a b c' });
  assert.equal(s1.items[0].status, 'running');
  assert.equal(s2.items.length, 1);
  assert.equal(s2.items[0].status, 'done');
  assert.equal(s2.items[0].output, 'a b c');
  assert.equal(s2.items[0].toolKind, 'execute');
  assert.equal(s2.items[0].detail, 'ls');
  const s3 = reduceThread(s2, { type: 'tool', id: 't9', status: 'done' });
  assert.equal(s3.items.length, 2);
  assert.equal(s3.items[1].title, 'Tool');
});

test('a tool event closes the open text block so later text starts a new one', () => {
  const s = fold([{ type: 'text', text: 'before' }, { type: 'tool', id: 't1', status: 'running' }, { type: 'text', text: 'after' }]);
  assert.deepEqual(s.items.map((i) => i.kind), ['text', 'tool', 'text']);
  assert.equal(s.items[0].open, false);
});

test('permission cards track pending ids and record the decision', () => {
  const s1 = fold([{ type: 'permission', requestId: 'r1', title: 'Bash', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }]);
  assert.deepEqual(s1.pending, ['r1']);
  assert.equal(s1.items[0].decision, null);
  const s2 = reduceThread(s1, { type: 'permission_resolved', requestId: 'r1', optionId: 'allow' });
  assert.deepEqual(s2.pending, []);
  assert.equal(s2.items[0].decision, 'allow');
});

test('turn_end appends meta, closes the turn and clears pending', () => {
  const s = fold([
    { type: 'user', text: 'go' }, { type: 'text', text: 'ok' },
    { type: 'permission', requestId: 'r1', title: 'x', options: [] },
    { type: 'turn_end', stopReason: 'end_turn', durationMs: 10, costUsd: 0.5 },
  ]);
  assert.equal(s.turnOpen, false);
  assert.deepEqual(s.pending, []);
  const meta = s.items[s.items.length - 1];
  assert.equal(meta.kind, 'meta');
  assert.equal(meta.stopReason, 'end_turn');
  assert.equal(meta.costUsd, 0.5);
});

test('session, commands, mode and plan land on state', () => {
  const s = fold([
    { type: 'session', sessionId: 'sid', model: 'm1', modes: { current: 'default', available: [] } },
    { type: 'commands', commands: [{ name: 'memory', description: '' }] },
    { type: 'mode', modeId: 'yolo' },
    { type: 'user', text: 'plan it' },
    { type: 'plan', entries: [{ content: 'a', status: 'pending', priority: 'high' }] },
    { type: 'plan', entries: [{ content: 'a', status: 'completed', priority: 'high' }] },
  ]);
  assert.equal(s.sessionId, 'sid');
  assert.equal(s.model, 'm1');
  assert.equal(s.commands[0].name, 'memory');
  assert.equal(s.modes.current, 'yolo');
  const plans = s.items.filter((i) => i.kind === 'plan');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].entries[0].status, 'completed');
});

test('error and unknown events', () => {
  const s = fold([{ type: 'user', text: 'x' }, { type: 'error', text: 'agent exited' }, { type: 'nonsense' }, null]);
  assert.equal(s.turnOpen, false);
  assert.equal(s.items[1].kind, 'meta');
  assert.equal(s.items[1].isError, true);
  assert.equal(s.items.length, 2);
});

test('claude permission offers allow-session only when the CLI sent suggestions', () => {
  const withS = normalizeClaudeEvent({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {}, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } })[0];
  assert.deepEqual(withS.options.map((o) => o.optionId), ['allow', 'allow-session', 'deny']);
  assert.equal(withS.options[1].kind, 'allow_always');
  const without = normalizeClaudeEvent({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })[0];
  assert.deepEqual(without.options.map((o) => o.optionId), ['allow', 'deny']);
});

test('acp session title and usage updates (copilot) land on state', () => {
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'session_info_update', title: 'Create a file', updatedAt: 'x' }), [{ type: 'title', title: 'Create a file' }]);
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'usage_update', used: 16295, size: 872000 }), [{ type: 'usage', used: 16295, size: 872000 }]);
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'usage_update', used: 'x' }), []);
  assert.deepEqual(normalizeAcpUpdate({ sessionUpdate: 'config_option_update', configOptions: [] }), []);
  const s = fold([{ type: 'title', title: 'T' }, { type: 'usage', used: 1, size: 10 }]);
  assert.equal(s.title, 'T');
  assert.deepEqual(s.usage, { used: 1, size: 10 });
  assert.equal(emptyThread().title, null);
});

test('copilot tool calls carry a string rawInput and an object rawOutput', () => {
  const call = normalizeAcpUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'apply_patch', kind: 'edit', status: 'pending', rawInput: '*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch\n' })[0];
  assert.equal(call.input, '*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch\n');
  const upd = normalizeAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', rawOutput: { message: 'File already exists', code: 'failure' } })[0];
  assert.equal(upd.status, 'error');
  assert.match(upd.output, /File already exists/);
});

test('a text chunk after an open thought closes the thought (ACP sends no end marker)', () => {
  const s = fold([{ type: 'thought', text: 'hmm' }, { type: 'text', text: 'Sure' }]);
  assert.deepEqual(s.items.map((i) => [i.kind, i.open]), [['thought', false], ['text', true]]);
  const t = fold([{ type: 'text', text: 'a' }, { type: 'thought', text: 'b' }]);
  assert.deepEqual(t.items.map((i) => [i.kind, i.open]), [['text', false], ['thought', true]]);
});

test('a permission that arrives before its tool_call seeds a titled tool card', () => {
  const s = fold([
    { type: 'permission', requestId: 'p1', toolCallId: 'tc9', title: 'Writing to hi.txt', options: [] },
    { type: 'tool', id: 'tc9', status: 'error', output: 'denied' },
  ]);
  assert.deepEqual(s.items.map((i) => i.kind), ['tool', 'permission']);
  assert.equal(s.items[0].title, 'Writing to hi.txt');
  assert.equal(s.items[0].status, 'error');
  assert.equal(s.items[0].output, 'denied');
  // An existing card keeps its own title and is not duplicated.
  const u = fold([
    { type: 'tool', id: 'tc1', title: 'echo hi', status: 'running' },
    { type: 'permission', requestId: 'p2', toolCallId: 'tc1', title: 'echo hi (shell)', options: [] },
  ]);
  assert.equal(u.items.filter((i) => i.kind === 'tool').length, 1);
  assert.equal(u.items[0].title, 'echo hi');
});

test('a subscription account (rate_limit_event) hides the per-turn dollar figure', () => {
  const ev = normalizeClaudeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: {} } } });
  assert.deepEqual(ev, [{ type: 'billing', plan: 'subscription' }]);
  assert.deepEqual(normalizeClaudeEvent({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'other' } }), []);
  const sub = fold([{ type: 'user', text: 'yo' }, ev[0], { type: 'turn_end', stopReason: 'end_turn', durationMs: 8000, costUsd: 2.19 }]);
  const meta = sub.items[sub.items.length - 1];
  assert.equal(meta.costUsd, undefined);
  assert.equal(meta.durationMs, 8000);
  const api = fold([{ type: 'user', text: 'yo' }, { type: 'turn_end', stopReason: 'end_turn', costUsd: 0.02 }]);
  assert.equal(api.items[api.items.length - 1].costUsd, 0.02);
  assert.equal(emptyThread().billing, null);
});

test('truncate cuts the thread from the given key onward and closes the turn', () => {
  const s = fold([
    { type: 'user', text: 'first' }, { type: 'text_final', text: 'reply one' }, { type: 'turn_end', stopReason: 'end_turn' },
    { type: 'user', text: 'second' }, { type: 'text_final', text: 'reply two' },
    { type: 'permission', requestId: 'p1', title: 'x', options: [] },
  ]);
  const secondKey = s.items.find((i) => i.kind === 'user' && i.text === 'second').key;
  const t = reduceThread(s, { type: 'truncate', key: secondKey });
  assert.deepEqual(t.items.map((i) => i.kind), ['user', 'text', 'meta']);
  assert.equal(t.turnOpen, false);
  assert.deepEqual(t.pending, []);
  assert.equal(reduceThread(s, { type: 'truncate', key: 'nope' }), s);
  const firstKey = s.items[0].key;
  assert.deepEqual(reduceThread(s, { type: 'truncate', key: firstKey }).items, []);
});

test('acp session carries the model list, deduped, and the reducer keeps it', () => {
  const s = normalizeAcpSession({ sessionId: 'x', models: { availableModels: [{ modelId: 'auto', name: 'Auto' }, { modelId: 'auto', name: 'Auto' }, { modelId: 'gpt-6', name: 'GPT 6' }], currentModelId: 'auto' } });
  assert.deepEqual(s.models, { current: 'auto', available: [{ id: 'auto', name: 'Auto', description: undefined }, { id: 'gpt-6', name: 'GPT 6', description: undefined }] });
  const st = fold([s, { type: 'session', model: 'GPT 6' }]);
  assert.equal(st.models.available.length, 2);
  assert.equal(st.model, 'GPT 6');
  assert.equal(normalizeAcpSession({ sessionId: 'y' }).models, undefined);
});
