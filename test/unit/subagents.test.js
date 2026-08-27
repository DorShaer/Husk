'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Subagents = require('../../src/lib/subagents');

const SESSION = 'b10721ca-79fd-4173-a984-c6c6bae362d4';

// A project tree shaped like the one the CLI writes: the parent's transcript
// beside a directory of the agents it ran inside itself.
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-subagents-'));
  const dir = path.join(root, SESSION);
  fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(root, `${SESSION}.jsonl`), '');
  return { root, dir, transcript: path.join(root, `${SESSION}.jsonl`) };
}

function writeAgent(dir, id, meta, { mtime } = {}) {
  const file = path.join(dir, `agent-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', agentId: id, message: { role: 'user', content: `work on ${id}` } })}\n`);
  fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

function scan(tree, { alive = true, now = Date.now() } = {}) {
  return Subagents.scanParent(
    { dir: tree.dir, sessionId: SESSION, cwd: '/work', alive, transcript: tree.transcript },
    { cache: new Map(), now },
  );
}

test('a task agent runs until its tool call is answered', () => {
  const tree = makeTree();
  writeAgent(path.join(tree.dir, 'subagents'), 'a1', { agentType: 'general-purpose', description: 'Map the files', toolUseId: 'toolu_1' });

  const running = scan(tree);
  assert.equal(running.length, 1);
  assert.equal(running[0].running, true);
  assert.equal(running[0].state, 'working');
  assert.equal(running[0].name, 'Map the files');
  assert.equal(running[0].id, 'sa-a1');
  assert.equal(running[0].sessionId, '');
  assert.equal(running[0].parentSessionId, SESSION);

  fs.appendFileSync(tree.transcript, `${JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } })}\n`);
  const done = scan(tree);
  assert.equal(done[0].running, false);
  assert.equal(done[0].state, 'done');
});

test('nothing runs under a parent that has exited', () => {
  const tree = makeTree();
  writeAgent(path.join(tree.dir, 'subagents'), 'a1', { toolUseId: 'toolu_1' });
  const rows = scan(tree, { alive: false });
  assert.equal(rows[0].running, false);
});

test('an agent spawned without a tool call is judged by whether it is still writing', () => {
  const tree = makeTree();
  const now = Date.now();
  writeAgent(path.join(tree.dir, 'subagents'), 'fresh', { agentType: 'AuthFixer', name: 'AuthFixer', teamName: 'session-1' });
  writeAgent(path.join(tree.dir, 'subagents'), 'stale', { agentType: 'AuthFixer', name: 'AuthFixer', teamName: 'session-1' }, { mtime: now - (Subagents.IDLE_MS * 2) });

  const rows = scan(tree, { now });
  const by = Object.fromEntries(rows.map((r) => [r.agentId, r.running]));
  assert.equal(by.fresh, true);
  assert.equal(by.stale, false);
});

test('a workflow agent runs until its run journal records a result', () => {
  const tree = makeTree();
  const run = path.join(tree.dir, 'subagents', 'workflows', 'wf_132126fa');
  fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(path.join(tree.dir, 'workflows', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tree.dir, 'workflows', 'scripts', 'sessions-page-redesign-wf_132126fa.js'), '');
  writeAgent(run, 'w1', { agentType: 'workflow-subagent', spawnDepth: 1 });
  writeAgent(run, 'w2', { agentType: 'workflow-subagent', spawnDepth: 1 });
  fs.writeFileSync(path.join(run, 'journal.jsonl'), [
    JSON.stringify({ type: 'started', agentId: 'w1' }),
    JSON.stringify({ type: 'started', agentId: 'w2' }),
    JSON.stringify({ type: 'result', agentId: 'w1', result: 'done' }),
    '',
  ].join('\n'));

  const all = scan(tree);
  const rows = all.filter((r) => !r.holder).sort((x, y) => x.agentId.localeCompare(y.agentId));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].running, false);
  assert.equal(rows[1].running, true);
  assert.equal(rows[0].runId, 'wf_132126fa');
  // A workflow writes no description, so the words the agent was started with
  // are what it is called.
  assert.equal(rows[1].name, 'work on w2');

  // The run itself is on the list as the thing its fleet hangs from, named by
  // the script it was launched from and running while any of its fleet is.
  const node = all.find((r) => r.holder === 'run');
  assert.ok(node, 'the run that fanned the fleet out is missing');
  assert.equal(node.name, 'sessions-page-redesign');
  assert.equal(node.kind, 'run');
  assert.equal(node.running, true);
  assert.equal(node.attachable, false);
  assert.equal(node.hasTranscript, false);
  assert.equal(node.parentSessionId, SESSION);
  // Every agent in the run points at the run, not at the chat.
  for (const r of rows) assert.equal(r.parentSessionId, node.sessionId);
});

test('a run with a finished fleet is over, and a run with no fleet is never drawn', () => {
  const tree = makeTree();
  const run = path.join(tree.dir, 'subagents', 'workflows', 'wf_ab0011');
  fs.mkdirSync(run, { recursive: true });
  writeAgent(run, 'w1', { agentType: 'workflow-subagent' });
  fs.writeFileSync(path.join(run, 'journal.jsonl'), [
    JSON.stringify({ type: 'started', agentId: 'w1' }),
    JSON.stringify({ type: 'result', agentId: 'w1', result: 'ok' }),
    '',
  ].join('\n'));
  // An empty run directory is a run that has written nothing yet.
  fs.mkdirSync(path.join(tree.dir, 'subagents', 'workflows', 'wf_cd0022'), { recursive: true });

  const all = scan(tree);
  const runs = all.filter((r) => r.holder === 'run');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].running, false);
  assert.equal(runs[0].state, 'done');
});

test('a workflow agent is named by the first sentence of the job it was given', () => {
  const tree = makeTree();
  const run = path.join(tree.dir, 'subagents', 'workflows', 'wf_9f01aa');
  fs.mkdirSync(run, { recursive: true });
  const file = path.join(run, 'agent-w1.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: 'Audit the canvas for theme independence. Read every theme block, then report what is hardcoded.',
    },
  })}\n`);
  fs.writeFileSync(path.join(run, 'agent-w1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent' }));
  fs.writeFileSync(path.join(run, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'w1' })}\n`);

  const rows = scan(tree).filter((r) => !r.holder);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Audit the canvas for theme independence');
});

test('an agent whose transcript says nothing falls back to the run that started it', () => {
  const tree = makeTree();
  const run = path.join(tree.dir, 'subagents', 'workflows', 'wf_44bc02');
  fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(path.join(tree.dir, 'workflows', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tree.dir, 'workflows', 'scripts', 'nightly-sweep-wf_44bc02.js'), '');
  fs.writeFileSync(path.join(run, 'agent-w9.jsonl'), '');
  fs.writeFileSync(path.join(run, 'agent-w9.meta.json'), JSON.stringify({ agentType: 'workflow-subagent' }));
  fs.writeFileSync(path.join(run, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'w9' })}\n`);

  const rows = scan(tree).filter((r) => !r.holder);
  assert.equal(rows.length, 1);
  assert.match(rows[0].name, /^nightly-sweep w9/);
});

test('a description in the metadata outranks the prompt', () => {
  const tree = makeTree();
  writeAgent(path.join(tree.dir, 'subagents'), 'a7', { agentType: 'general-purpose', description: 'Map the files', toolUseId: 'toolu_7' });
  const rows = scan(tree);
  assert.equal(rows[0].name, 'Map the files');
});

test('a title is the first sentence, and a prompt with no sentence break keeps its first line', () => {
  assert.equal(Subagents.promptTitle('Audit the canvas. Then report.'), 'Audit the canvas');
  assert.equal(Subagents.promptTitle('  \n  Rebuild the sessions cockpit\nand nothing else'), 'Rebuild the sessions cockpit');
  assert.equal(Subagents.promptTitle('No. Way'), 'No. Way');
  assert.equal(Subagents.promptTitle(''), '');
});

test('a fleet keeps everything live and only the last stretch of finished work', () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const rows = [
    { id: 'a', sessionId: 's-a', running: true, updatedAt: now - day, parentSessionId: 'chat-old' },
    { id: 'b', sessionId: 's-b', running: false, updatedAt: now, parentSessionId: 'chat-new' },
    // A generation down, and hours old: an agent that an agent started belongs
    // to the same piece of history as the chat at the top of the chain.
    { id: 'c', sessionId: 's-c', running: false, updatedAt: now - (4 * 60 * 60 * 1000), parentSessionId: 's-b' },
    // Another chat entirely, but it stopped in the same stretch of work.
    { id: 'd', sessionId: 's-d', running: false, updatedAt: now - 60_000, parentSessionId: 'chat-old' },
    { id: 'e', sessionId: '', running: false, updatedAt: now - day, parentSessionId: 'chat-old' },
  ];
  const kept = Subagents.retainLastBatch(rows).map((r) => r.id).sort();
  assert.deepEqual(kept, ['a', 'b', 'c', 'd']);
});

test('an agent that failed before writing anything is kept on the time it started', () => {
  const now = Date.now();
  const rows = [
    { id: 'ran', sessionId: 's-ran', running: false, updatedAt: now, startedAt: now - (30 * 60_000), parentSessionId: '' },
    { id: 'never', sessionId: 's-never', running: false, updatedAt: 0, startedAt: now - (12 * 60_000), parentSessionId: '' },
    { id: 'old', sessionId: 's-old', running: false, updatedAt: 0, startedAt: now - (24 * 60 * 60_000), parentSessionId: '' },
  ];
  const kept = Subagents.retainLastBatch(rows).map((r) => r.id).sort();
  assert.deepEqual(kept, ['never', 'ran']);
  assert.equal(Subagents.batchKey(rows[0], rows), 'agent:ran');
});

test('a fleet with nothing finished keeps every live agent', () => {
  const rows = [{ id: 'a', running: true, updatedAt: 1 }, { id: 'b', running: true, updatedAt: 2 }];
  assert.equal(Subagents.retainLastBatch(rows).length, 2);
});

test('an answered tool call is remembered across scans of an appended transcript', () => {
  const tree = makeTree();
  const cache = new Map();
  fs.appendFileSync(tree.transcript, `${JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a' }] } })}\n`);
  assert.equal(Subagents.resolvedToolUses(tree.transcript, cache).has('toolu_a'), true);

  fs.appendFileSync(tree.transcript, `${JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b' }] } })}\n`);
  const ids = Subagents.resolvedToolUses(tree.transcript, cache);
  assert.equal(ids.has('toolu_a'), true);
  assert.equal(ids.has('toolu_b'), true);
});

test('an agent that survives to the screen carries what it was asked', () => {
  const tree = makeTree();
  writeAgent(path.join(tree.dir, 'subagents'), 'a1', { agentType: 'workflow-subagent' });
  const rows = Subagents.describe(scan(tree));
  assert.equal(rows[0].intent, 'work on a1');
});
