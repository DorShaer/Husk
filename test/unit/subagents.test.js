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

test('the scan and head caches stay bounded under many transcripts, same result', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-subcap-'));
  const cache = new Map();
  const heads = new Map();
  // One real transcript with two tool-use/result pairs, scanned repeatedly.
  const real = path.join(dir, 'real.jsonl');
  fs.writeFileSync(real, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_a' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_b' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b' }] } }),
  ].join('\n') + '\n');
  const ids1 = Subagents.resolvedToolUses(real, cache);
  const n1 = ids1.size;
  // Flood the cache with far more distinct transcript paths than the cap.
  for (let i = 0; i < 2000; i++) Subagents.resolvedToolUses(path.join(dir, `ghost-${i}.jsonl`), cache);
  // The real entry was evicted, so a fresh scan recomputes it from scratch and
  // must return the identical id set.
  const ids2 = Subagents.resolvedToolUses(real, new Map());
  assert.equal(ids2.size, n1, 'rescanning an evicted transcript changed the result');
  assert.ok(cache.size <= 512, `scan cache grew past its cap: ${cache.size}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

const line = (o) => JSON.stringify(o);
const human = (uuid, at, text, extra = {}) => line({ type: 'user', uuid, timestamp: new Date(at).toISOString(), promptSource: 'sdk', message: { role: 'user', content: text }, ...extra });
const spawn = (id, at) => line({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'x' } }] } });

test('an agent links to the human prompt its call was made under, skipping injected turns', () => {
  const t0 = Date.parse('2026-11-17T10:00:00Z');
  const idx = Subagents.indexLines(Subagents.emptyIndex(), [
    human('u1', t0, '[Husk Brain: notes kept here]\n- a note\n[End of Husk Brain notes]\nAudit the agents page'),
    spawn('toolu_a', t0 + 1000),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' }] } }),
    human('u2', t0 + 5000, '<task-notification>\n<tool-use-id>toolu_z</tool-use-id>\n</task-notification>', { promptSource: 'system', origin: { kind: 'task-notification' } }),
    human('u3', t0 + 6000, 'meta', { isMeta: true }),
    line({ type: 'user', timestamp: new Date(t0 + 7000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b' }] }, toolUseResult: { status: 'async_launched' } }).replace('"toolUseResult":{"status":"async_launched"}', '"toolUseResult":{"isAsync":true,"status":"async_launched"}'),
    spawn('toolu_b', t0 + 6500),
    human('u4', t0 + 9000, 'Fix the canvas'),
  ].join('\n'));
  assert.deepEqual(idx.prompts.map((p) => p.key), ['u1', 'u4']);
  assert.equal(idx.prompts[0].text, 'Audit the agents page');
  assert.equal(Subagents.promptFor(idx, { toolUseId: 'toolu_a' }).key, 'u1');
  assert.equal(Subagents.promptFor(idx, { toolUseId: 'toolu_a' }).link, 'exact');
  assert.equal(Subagents.promptFor(idx, { toolUseId: 'toolu_b' }).key, 'u1', 'injected turns between are skipped');
  const late = Subagents.promptFor(idx, { toolUseId: 'toolu_unknown', startedAt: t0 + 9500 });
  assert.equal(late.key, 'u4');
  assert.equal(late.link, 'time');
  assert.equal(Subagents.promptFor(idx, { startedAt: t0 - 1 }), null);
  assert.equal(idx.done.has('toolu_a'), true);
  assert.equal(idx.done.has('toolu_b'), false, 'a background launch receipt is not completion');
  assert.equal(idx.notified.has('toolu_z'), true);
});

test('state: finished, answered, notified, quiet and moving', () => {
  const now = 1_000_000_000;
  const idx = Subagents.emptyIndex();
  idx.done.add('toolu_done');
  idx.notified.add('toolu_bg');
  const st = (meta, mtime = now - 1000, alive = true) => Subagents.subagentState({ alive, meta, idx, mtime, now });
  assert.equal(st({ toolUseId: 'toolu_x' }), 'working');
  assert.equal(st({ toolUseId: 'toolu_x' }, now - 5 * 60 * 1000), 'quiet', 'open but quiet does not move');
  assert.equal(st({ toolUseId: 'toolu_x', finished: true }), 'done');
  assert.equal(st({ toolUseId: 'toolu_done' }), 'done');
  assert.equal(st({ toolUseId: 'toolu_bg' }), 'done');
  assert.equal(st({ toolUseId: 'toolu_x' }, now, false), 'done', 'nothing runs under an exited parent');
  assert.equal(st({}, now - Subagents.IDLE_MS), 'done');
});

test('a nested agent is settled by the transcript of the agent that spawned it', () => {
  const tree = makeTree();
  const dir = path.join(tree.dir, 'subagents');
  writeAgent(dir, 'parent', { description: 'Lead', toolUseId: 'toolu_p' });
  writeAgent(dir, 'child', { description: 'Facts', toolUseId: 'toolu_c', parentAgentId: 'parent' });
  fs.appendFileSync(tree.transcript, `${human('u1', Date.now() - 1000, 'Map it')}\n${spawn('toolu_p', Date.now() - 900)}\n`);
  let by = Object.fromEntries(scan(tree).map((r) => [r.agentId, r]));
  assert.equal(by.child.state, 'working');
  assert.equal(by.child.parentAgentId, 'parent');
  assert.equal(by.child.prompt.key, 'u1', 'a nested agent answers to its ancestor prompt');
  fs.appendFileSync(path.join(dir, 'agent-parent.jsonl'), `${line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_c' }] } })}\n`);
  by = Object.fromEntries(scan(tree).map((r) => [r.agentId, r]));
  assert.equal(by.child.state, 'done', 'the answer in the parent agent ends the child');
  assert.equal(by.parent.state, 'working');
});
