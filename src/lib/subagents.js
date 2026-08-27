'use strict';

// Agents a chat runs inside its own process: the ones a Task call spawns, the
// named teammates a session keeps around, and the fleets a workflow fans out.
// They are turns inside their parent rather than sessions of their own, so the
// CLI's agent inventory never lists them and the only record is on disk:
//
//   <projects>/<slug>/<parentSessionId>/subagents/
//     agent-<id>.jsonl        the conversation, isSidechain records
//     agent-<id>.meta.json    {agentType, description, toolUseId, name, ...}
//     workflows/wf_<runId>/
//       agent-<id>.jsonl / .meta.json
//       journal.jsonl         {type:'started'|'result', agentId}
//
// Everything here reads that tree and answers two questions: which of those
// agents is still working, and which finished conversations are worth keeping
// on screen.

const fs = require('fs');
const path = require('path');

const AGENT_FILE = /^agent-(.+)\.jsonl$/;
const RUN_DIR = /^wf_[A-Za-z0-9._-]+$/;
const TOOL_RESULT = /"tool_use_id":"([A-Za-z0-9_-]+)"/g;

// How long an agent with no completion record can sit silent before it reads as
// finished. Only agents whose spawn left no tool call to match against fall back
// to this, and a parent that has exited ends them regardless.
const IDLE_MS = 120000;

function readJson(file) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file found by walking the session directory
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function statOf(file) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file found by walking the session directory
  try { return fs.statSync(file); } catch (_) { return null; }
}

function listDir(dir) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory under the session tree
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

// The tool calls a parent has already answered. A subagent spawned by a Task
// call is over the moment its `tool_use_id` comes back as a result, which is
// exact where a timer is a guess.
//
// The scan is forward-only: each pass reads the bytes appended since the last
// one and keeps the trailing partial line, so a multi-megabyte transcript is
// read once however often the fleet is polled.
function resolvedToolUses(transcript, cache) {
  if (!transcript) return new Set();
  let ent = cache.get(transcript);
  if (!ent) { ent = { off: 0, rest: '', ids: new Set() }; cache.set(transcript, ent); }
  const st = statOf(transcript);
  if (!st) return ent.ids;
  // A file that shrank was replaced, so the offset it was read to means nothing.
  if (st.size < ent.off) { ent.off = 0; ent.rest = ''; ent.ids = new Set(); }
  if (st.size === ent.off) return ent.ids;
  let fd = null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the agent's own transcript, named by the scan
    fd = fs.openSync(transcript, 'r');
    const len = st.size - ent.off;
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, ent.off);
    const text = ent.rest + buf.toString('utf8', 0, n);
    const cut = text.lastIndexOf('\n');
    ent.rest = cut === -1 ? text : text.slice(cut + 1);
    ent.off = st.size;
    const whole = cut === -1 ? '' : text.slice(0, cut);
    let m = null;
    TOOL_RESULT.lastIndex = 0;
    while ((m = TOOL_RESULT.exec(whole)) !== null) ent.ids.add(m[1]);
  } catch (_) {
    return ent.ids;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
  return ent.ids;
}

// Which agents a workflow run has started and which have handed back a result.
// The journal is the run's own record, so it answers for the whole fleet in one
// read rather than one guess per agent.
function runProgress(dir) {
  const started = new Set();
  const done = new Set();
  let text = '';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the run directory the scan just listed
  try { text = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'); } catch (_) { return { started, done }; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec = null;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec || !rec.agentId) continue;
    if (rec.type === 'started') started.add(String(rec.agentId));
    else done.add(String(rec.agentId));
  }
  return { started, done };
}

// A readable name for an agent, in the order a person would pick one: what it
// was asked to do, the name it was given, then the id it can always be called.
// A workflow spawns its fleet without either, so those borrow the run's name and
// keep enough of the id to tell siblings apart.
// The opening line of an agent's own transcript. A workflow writes its fleet
// with nothing in the metadata but a type, so the only place the work it was
// given survives is the prompt it was handed, and that is the first record of
// its file. The record never changes once written, so each file is read once
// however often the fleet is polled.
const HEAD_BYTES = 65536;

function promptHead(file, cache) {
  if (cache && cache.has(file)) return cache.get(file);
  const text = firstPrompt(file, HEAD_BYTES);
  if (cache) cache.set(file, text);
  return text;
}

// What to call an agent given the words it was started with. The first sentence
// is what a person wrote to say what the job was, so it is the title; anything
// past it is the briefing.
function promptTitle(prompt) {
  const raw = String(prompt || '').trim();
  if (!raw) return '';
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (!line) return '';
  const stop = line.search(/[.:!?](\s|$)/);
  const head = (stop > 12 ? line.slice(0, stop) : line).trim();
  return head.replace(/\s+/g, ' ').slice(0, 90);
}

function agentName(meta, fileId, runName, prompt) {
  const desc = meta && typeof meta.description === 'string' ? meta.description.replace(/\s+/g, ' ').trim() : '';
  const named = meta && typeof meta.name === 'string' ? meta.name.trim() : '';
  if (desc || named) return (desc || named).slice(0, 120);
  const title = promptTitle(prompt);
  if (title) return title;
  const short = String(fileId).slice(0, 8);
  return (runName ? `${runName} ${short}` : `agent ${short}`).slice(0, 120);
}

// What each workflow run is called. The run writes its script out under the
// chat's own directory, named for the workflow, which is the only place the
// name a person would recognise survives.
function runScriptNames(sessionDir) {
  const out = new Map();
  for (const ent of listDir(path.join(sessionDir, 'workflows', 'scripts'))) {
    if (!ent.isFile() || !ent.name.endsWith('.js')) continue;
    const m = /^(.*)-(wf_[A-Za-z0-9._-]+)\.js$/.exec(ent.name);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

// The session key a run stands under. A run is not a session, but the graph
// links a child to its parent by session, so the run needs one key of its own
// that no CLI session could ever collide with.
function runKey(runId) {
  return `wf:${runId}`;
}

// One workflow run, as the thing its fleet hangs from. It is scenery in the same
// way a chat is: it did no work itself, it is where work came from, and it is
// on screen only while something it started is.
function runNode({ runId, name, parentSessionId, cwd, fleet, now }) {
  let startedAt = now;
  let updatedAt = 0;
  let running = false;
  for (const a of fleet) {
    if (a.startedAt && a.startedAt < startedAt) startedAt = a.startedAt;
    if (a.updatedAt > updatedAt) updatedAt = a.updatedAt;
    if (a.running) running = true;
  }
  return {
    id: `wf-${runId}`,
    agentId: '',
    kind: 'run',
    // Scenery, like the chat and the project a graph already draws. Nothing that
    // counts agents may count this.
    holder: 'run',
    sessionId: runKey(runId),
    parentSessionId,
    runId,
    teamName: '',
    agentType: '',
    name: String(name || runId).slice(0, 120),
    cwd,
    running,
    attachable: false,
    held: false,
    state: running ? 'working' : 'done',
    status: '',
    detail: '',
    intent: '',
    needs: '',
    tokens: 0,
    startedAt,
    updatedAt: updatedAt || now,
    hasTranscript: false,
    transcript: '',
  };
}

function agentRow({ file, dir, id, parentSessionId, cwd, runId, runName, running, now, heads }) {
  const meta = readJson(path.join(dir, `agent-${id}.meta.json`)) || {};
  const st = statOf(file);
  const startedAt = st ? Math.round(st.birthtimeMs || st.ctimeMs || st.mtimeMs) : now;
  const updatedAt = st ? Math.round(st.mtimeMs) : now;
  return {
    // Prefixed so a subagent id can never be mistaken for a background agent's
    // and sent to a CLI command that only knows about background agents.
    id: `sa-${id}`,
    agentId: String(id),
    kind: 'subagent',
    // A subagent has no session of its own: it lives inside its parent's, and
    // every surface keyed on session ids must skip it rather than claim it.
    sessionId: '',
    parentSessionId,
    runId: runId || '',
    teamName: typeof meta.teamName === 'string' ? meta.teamName : '',
    agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
    name: agentName(meta, id, runName, promptHead(file, heads)),
    cwd,
    running,
    // In-process agents are reached through their parent chat, never attached to
    // or resumed on their own.
    attachable: false,
    held: false,
    state: running ? 'working' : 'done',
    status: '',
    detail: '',
    intent: typeof meta.description === 'string' ? meta.description.replace(/\s+/g, ' ').trim().slice(0, 400) : '',
    needs: '',
    tokens: 0,
    startedAt,
    updatedAt,
    hasTranscript: !!st,
    transcript: file,
  };
}

// Every in-process agent under one parent chat. `alive` is the parent's own
// process: when it has exited, nothing it was running is still running, whatever
// the files say.
function scanParent({ dir, sessionId, cwd, alive, transcript }, { cache, now, heads }) {
  const base = path.join(dir, 'subagents');
  const rows = [];
  const entries = listDir(base);
  if (!entries.length) return rows;
  const resolved = alive ? resolvedToolUses(transcript, cache) : null;

  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = AGENT_FILE.exec(ent.name);
    if (!m) continue;
    const id = m[1];
    const file = path.join(base, ent.name);
    const meta = readJson(path.join(base, `agent-${id}.meta.json`)) || {};
    let running = false;
    if (alive) {
      const toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId : '';
      // A spawn with a tool call behind it is answered exactly. One without
      // (a forked skill, a named teammate) is judged by whether it is still
      // writing.
      if (toolUseId) running = !resolved.has(toolUseId);
      else {
        const st = statOf(file);
        running = !!st && (now - st.mtimeMs) < IDLE_MS;
      }
    }
    rows.push(agentRow({ file, dir: base, id, parentSessionId: sessionId, cwd, runId: '', running, now, heads }));
  }

  const runsDir = path.join(base, 'workflows');
  const runNames = runScriptNames(dir);
  for (const run of listDir(runsDir)) {
    if (!run.isDirectory() || !RUN_DIR.test(run.name)) continue;
    const runPath = path.join(runsDir, run.name);
    const { started, done } = runProgress(runPath);
    const fleet = [];
    for (const ent of listDir(runPath)) {
      if (!ent.isFile()) continue;
      const m = AGENT_FILE.exec(ent.name);
      if (!m) continue;
      const id = m[1];
      fleet.push(agentRow({
        file: path.join(runPath, ent.name),
        dir: runPath,
        id,
        // A workflow fleet hangs off the run that fanned it out, not off the
        // chat, so the shape on screen is the shape the work actually took.
        parentSessionId: runKey(run.name),
        cwd,
        runId: run.name,
        runName: runNames.get(run.name) || '',
        running: alive && started.has(id) && !done.has(id),
        now,
        heads,
      }));
    }
    if (!fleet.length) continue;
    rows.push(runNode({
      runId: run.name,
      name: runNames.get(run.name) || run.name,
      parentSessionId: sessionId,
      cwd,
      fleet,
      now,
    }));
    rows.push(...fleet);
  }
  return rows;
}

// The chat an agent ultimately descends from. An agent that started other agents
// is a link in the chain rather than the top of it, so the walk follows parents
// until it leaves the fleet and lands on the conversation a person started.
// Bounded, because a lineage read off disk can point at itself.
function rootKey(a, bySession) {
  let node = a;
  for (let hop = 0; hop < 8; hop++) {
    const parent = node.parentSessionId ? bySession.get(node.parentSessionId) : null;
    if (!parent || parent === node) break;
    node = parent;
  }
  return node.parentSessionId ? `chat:${node.parentSessionId}` : `agent:${node.id}`;
}

// The batch an agent belongs to: everything one chat set off, however many
// generations deep, counts as one piece of history.
function batchKey(a, rows) {
  if (!a) return '';
  const bySession = new Map();
  for (const r of rows || []) if (r && r.sessionId) bySession.set(r.sessionId, r);
  return rootKey(a, bySession);
}

// How far back from the last thing that stopped still counts as the same
// stretch of work. A fan-out ends in a burst, and everything in that burst is
// one piece of history however many chats it came from.
const HISTORY_WINDOW_MS = 30 * 60 * 1000;

// When an agent last showed a sign of life. An agent that failed before writing
// anything has only the moment it started, and it is exactly the one a person
// needs to see.
function stampOf(a) {
  return Math.max(Number(a && a.updatedAt) || 0, Number(a && a.startedAt) || 0);
}

// Live agents, plus the last stretch of finished work: whatever the chat that
// ran last set off, and whatever else stopped around the same time. Older
// agents stay on disk and in the sessions list rather than crowding the fleet
// with everything the machine has ever run.
function retainLastBatch(rows, { windowMs = HISTORY_WINDOW_MS } = {}) {
  const live = [];
  const over = [];
  // Scenery is not work, so it is never what the history window is measured
  // against. It stays, and the graph drops any of it left holding nothing.
  const scenery = [];
  for (const a of rows || []) {
    if (a && a.holder) { scenery.push(a); continue; }
    (a && a.running ? live : over).push(a);
  }
  if (!over.length) return scenery.concat(live);
  const bySession = new Map();
  for (const r of rows) if (r && r.sessionId) bySession.set(r.sessionId, r);
  let newest = null;
  for (const a of over) if (!newest || stampOf(a) > stampOf(newest)) newest = a;
  const key = rootKey(newest, bySession);
  const floor = stampOf(newest) - windowMs;
  return scenery.concat(live, over.filter((a) => rootKey(a, bySession) === key || stampOf(a) >= floor));
}

// The opening of an agent's own conversation, which is the nearest thing a
// workflow agent has to a brief. Bounded so a first prompt that arrived with a
// large attachment cannot pull it all in.
function firstPrompt(transcript, bytes) {
  let fd = null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the agent's own transcript, named by the scan
    fd = fs.openSync(transcript, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    const line = buf.toString('utf8', 0, n).split('\n')[0];
    const rec = JSON.parse(line);
    const content = rec && rec.message ? rec.message.content : null;
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') : '');
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Fill in what an agent is working on for the rows that survive to the screen.
// Kept separate from the scan so a machine with hundreds of finished agents
// reads a handful of transcripts rather than all of them.
function describe(rows, { bytes = 64 * 1024 } = {}) {
  for (const a of rows || []) {
    if (!a || a.kind !== 'subagent' || a.intent || !a.transcript) continue;
    a.intent = firstPrompt(a.transcript, bytes);
  }
  return rows;
}

module.exports = {
  scanParent, retainLastBatch, describe, batchKey, resolvedToolUses, runProgress,
  agentName, promptTitle, promptHead, runKey, IDLE_MS,
};
