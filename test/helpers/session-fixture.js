'use strict';

// Writes synthetic CLI transcripts under a home directory, shaped like a real
// heavy user's: mostly small chats, a long tail of large ones.

const fs = require('node:fs');
const path = require('node:path');

function turnLines(i, cwd, bytes, t0) {
  const pad = 'x'.repeat(900);
  const lines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: `s${i}` }),
    JSON.stringify({ type: 'user', timestamp: new Date(t0).toISOString(), cwd, origin: { kind: 'human' }, message: { role: 'user', content: `task number ${i}` } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(t0).toISOString(), cwd, message: { model: 'm', content: [{ type: 'text', text: 'on it' }] } }),
  ];
  let size = lines.reduce((n, l) => n + l.length + 1, 0);
  let k = 0;
  while (size < bytes) {
    const ts = new Date(t0 + (++k) * 1000).toISOString();
    const l = k % 2
      ? JSON.stringify({ type: 'assistant', timestamp: ts, cwd, message: { model: 'm', content: [{ type: 'text', text: `reply ${k} ${pad}` }] } })
      : JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { role: 'user', content: [{ type: 'tool_result', content: pad }] } });
    lines.push(l);
    size += l.length + 1;
  }
  lines.push(JSON.stringify({ type: 'ai-title', aiTitle: `Session ${i}` }));
  lines.push(JSON.stringify({ type: 'api-request', timestamp: new Date().toISOString() }));
  return lines.join('\n') + '\n';
}

// Size in bytes of transcript i, following a heavy-tailed spread.
function sizeFor(i, count) {
  if (i === count - 1 && count >= 1000) return 40 * 1024 * 1024;
  const r = i % 100;
  if (r < 80) return 30 * 1024;
  if (r < 95) return 120 * 1024;
  if (r < 99) return 1024 * 1024;
  return 6 * 1024 * 1024;
}

// Writes `count` claude transcripts spread over `projects` project folders.
// `sizes: 'tiny'` keeps every file a few hundred bytes for fast unit tests.
function seedClaude(home, { count = 2500, projects = 25, sizes = 'real', cwdFor } = {}) {
  // Recent enough that a CLI's own transcript cleanup leaves them alone.
  const t0 = Date.now() - (count + 60) * 60000;
  const ids = [];
  for (let i = 0; i < count; i++) {
    const cwd = cwdFor ? cwdFor(i) : path.join(home, 'work', `p${i % projects}`);
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const id = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const bytes = sizes === 'tiny' ? 0 : sizeFor(i, count);
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, turnLines(i, cwd, bytes, t0 + i * 60000));
    const at = new Date(t0 + i * 60000);
    fs.utimesSync(file, at, at);
    ids.push(id);
  }
  return ids;
}

function seedCopilot(home, { count = 200 } = {}) {
  const root = path.join(home, '.copilot', 'session-state');
  for (let i = 0; i < count; i++) {
    const id = `c${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date(Date.now() - (count - i) * 60000).toISOString();
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${path.join(home, 'work', 'p0')}\ncreated_at: ${ts}\nupdated_at: ${ts}\n`);
    const ev = [
      { type: 'user.message', timestamp: ts, data: { content: `copilot task ${i}` } },
      { type: 'assistant.message', timestamp: ts, data: { content: 'ok' } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'events.jsonl'), ev.repeat(40));
  }
}

module.exports = { seedClaude, seedCopilot };
