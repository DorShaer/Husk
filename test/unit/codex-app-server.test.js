'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  codexModel, codexInput, codexSession, diffSides,
  normalizeCodexNotification: norm, normalizeCodexApproval, codexDecision,
} = require('../../src/lib/codex-app-server');

test('codexModel reads every spelling of the model flag', () => {
  assert.equal(codexModel('codex --model gpt-x'), 'gpt-x');
  assert.equal(codexModel('codex --model=gpt-y'), 'gpt-y');
  assert.equal(codexModel('/usr/bin/codex -m gpt-z'), 'gpt-z');
  assert.equal(codexModel('codex'), null);
});

test('codexInput carries text, and images as data URLs', () => {
  assert.deepEqual(codexInput('hi'), [{ type: 'text', text: 'hi', text_elements: [] }]);
  assert.deepEqual(codexInput('', [{ mimeType: 'image/jpeg', data: 'QUJD' }]), [{ type: 'image', url: 'data:image/jpeg;base64,QUJD' }]);
  assert.equal(codexInput('look', [{ data: 'QUJD' }])[1].url, 'data:image/png;base64,QUJD');
});

test('codexSession names the thread and resolves the model against the list', () => {
  const ev = codexSession({ thread: { id: 'T1' }, model: 'm1' }, [
    { id: 'm1', displayName: 'Model One', description: 'd' },
    { id: 'm2', displayName: 'Hidden', hidden: true },
  ]);
  assert.equal(ev.sessionId, 'T1');
  assert.equal(ev.model, 'Model One');
  assert.deepEqual(ev.models, { current: 'm1', available: [{ id: 'm1', name: 'Model One', description: 'd' }] });
  const bare = codexSession({ thread: { id: 'T2' }, model: 'm9' }, null);
  assert.equal(bare.model, 'm9');
  assert.equal(bare.models, undefined);
});

test('diffSides splits hunks into the two sides and treats raw content as the new file', () => {
  assert.deepEqual(diffSides('--- a\n+++ b\n@@ -1,2 +1,2 @@\n keep\n-old\n+new', 'update'), { oldText: 'keep\nold', newText: 'keep\nnew' });
  assert.deepEqual(diffSides('x\n', 'add'), { oldText: null, newText: 'x\n' });
  assert.deepEqual(diffSides('gone', 'delete'), { oldText: 'gone', newText: '' });
});

test('stream notifications map to text, thought and block events', () => {
  assert.deepEqual(norm('turn/started', {}), [{ type: 'turn_start' }]);
  assert.deepEqual(norm('item/agentMessage/delta', { delta: 'a' }), [{ type: 'text', text: 'a' }]);
  assert.deepEqual(norm('item/reasoning/summaryTextDelta', { delta: 't' }), [{ type: 'thought', text: 't' }]);
  assert.deepEqual(norm('item/reasoning/textDelta', { delta: 't' }), [{ type: 'thought', text: 't' }]);
  assert.deepEqual(norm('item/started', { item: { type: 'agentMessage', id: 'm' } }), [{ type: 'block_end' }]);
  assert.deepEqual(norm('item/completed', { item: { type: 'agentMessage', id: 'm', text: 'done' } }), [{ type: 'text_final', text: 'done' }, { type: 'block_end' }]);
  assert.deepEqual(norm('item/completed', { item: { type: 'agentMessage', id: 'm', text: ' ' } }), [{ type: 'block_end' }]);
  assert.deepEqual(norm('item/started', { item: { type: 'userMessage', id: 'u' } }), []);
  assert.deepEqual(norm('thread/status/changed', {}), []);
});

test('a command becomes a Shell card that settles on its exit', () => {
  const item = { type: 'commandExecution', id: 'e1', command: "/bin/zsh -lc 'ls'", cwd: '/w', commandActions: [{ type: 'unknown', command: 'ls' }] };
  assert.deepEqual(norm('item/started', { item }), [{ type: 'tool', id: 'e1', status: 'running', title: 'Shell', kind: 'execute', detail: 'ls', input: { command: 'ls', cwd: '/w' } }]);
  assert.deepEqual(norm('item/completed', { item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'a\n' } }), [{ type: 'tool', id: 'e1', status: 'done', output: 'a\n' }]);
  assert.equal(norm('item/completed', { item: { ...item, status: 'completed', exitCode: 2 } })[0].status, 'error');
  assert.equal(norm('item/completed', { item: { ...item, status: 'declined' } })[0].status, 'error');
});

test('file changes, MCP calls and web searches become cards', () => {
  const fc = norm('item/started', { item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/w/a.md', kind: { type: 'add' }, diff: 'x\n' }] } })[0];
  assert.equal(fc.kind, 'edit');
  assert.deepEqual(fc.locations, ['/w/a.md']);
  assert.deepEqual(fc.diffs, [{ path: '/w/a.md', oldText: null, newText: 'x\n' }]);
  const mcp = { type: 'mcpToolCall', id: 'c1', server: 'srv', tool: 'do', arguments: { a: 1 } };
  assert.equal(norm('item/started', { item: mcp })[0].title, 'srv.do');
  assert.deepEqual(norm('item/completed', { item: { ...mcp, status: 'failed', error: { message: 'boom' } } }), [{ type: 'tool', id: 'c1', status: 'error', output: 'boom' }]);
  assert.match(norm('item/completed', { item: { ...mcp, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } } })[0].output, /"ok"/);
  assert.equal(norm('item/started', { item: { type: 'webSearch', id: 'w1', query: 'husk' } })[0].detail, 'husk');
});

test('plan, usage and title notifications', () => {
  assert.deepEqual(norm('turn/plan/updated', { plan: [{ step: 'one', status: 'inProgress' }, { step: 'two', status: 'pending' }] }), [{ type: 'plan', entries: [
    { content: 'one', status: 'in_progress', priority: '' }, { content: 'two', status: 'pending', priority: '' },
  ] }]);
  assert.deepEqual(norm('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 } }), [{ type: 'usage', used: 10, size: 100 }]);
  assert.deepEqual(norm('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: null } }), []);
  assert.deepEqual(norm('thread/name/updated', { threadName: 'Fix it' }), [{ type: 'title', title: 'Fix it' }]);
  assert.deepEqual(norm('thread/name/updated', {}), []);
});

test('a turn ends done, stopped or failed', () => {
  assert.deepEqual(norm('turn/completed', { turn: { status: 'completed', durationMs: 5 } }), [{ type: 'turn_end', stopReason: 'end_turn', isError: false, durationMs: 5, text: undefined }]);
  assert.equal(norm('turn/completed', { turn: { status: 'interrupted' } })[0].stopReason, 'cancelled');
  const failed = norm('turn/completed', { turn: { status: 'failed', error: { message: 'quota' } } })[0];
  assert.equal(failed.isError, true);
  assert.equal(failed.text, 'quota');
  assert.deepEqual(norm('error', { willRetry: true, error: { message: 'retrying' } }), [{ type: 'status', text: 'retrying' }]);
  assert.deepEqual(norm('error', { willRetry: false, error: { message: 'final' } }), []);
});

test('approvals offer what codex will take, and always a way to refuse', () => {
  const cmd = normalizeCodexApproval('p1', 'item/commandExecution/requestApproval', {
    itemId: 'e1', command: "/bin/zsh -lc 'rm x'", cwd: '/w', commandActions: [{ type: 'unknown', command: 'rm x' }], reason: 'why', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: {} }, 'cancel'],
  });
  assert.equal(cmd.toolCallId, 'e1');
  // The full command as it will run, not the parsed action.
  assert.equal(cmd.detail, "/bin/zsh -lc 'rm x'\nwhy");
  assert.equal(cmd.input.command, "/bin/zsh -lc 'rm x'");
  assert.deepEqual(cmd.options.map((o) => o.optionId), ['accept', 'decline']);
  const patch = normalizeCodexApproval('p2', 'item/fileChange/requestApproval', { itemId: 'f1' });
  assert.deepEqual(patch.options.map((o) => o.optionId), ['accept', 'acceptForSession', 'decline']);
  assert.equal(normalizeCodexApproval('p3', 'item/tool/requestUserInput', {}), null);
});

test('codexDecision passes known answers and cancels on anything else', () => {
  assert.deepEqual(codexDecision('accept'), { decision: 'accept' });
  assert.deepEqual(codexDecision('acceptForSession'), { decision: 'acceptForSession' });
  assert.deepEqual(codexDecision('decline'), { decision: 'decline' });
  assert.deepEqual(codexDecision(null), { decision: 'cancel' });
  assert.deepEqual(codexDecision('nonsense'), { decision: 'cancel' });
});
