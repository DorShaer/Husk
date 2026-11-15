'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { withoutContext } = require('./brain');

const HEAD_BYTES = 32768;
// Past this size a transcript is kept as a chat without a whole-file read.
const WHOLE_SCAN_CAP = 4 * 1024 * 1024;

function readHead(filePath, bytes) {
  const buf = Buffer.alloc(bytes);
  const fd = fs.openSync(filePath, 'r');
  try { return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, bytes, 0)); }
  finally { fs.closeSync(fd); }
}

// Reads authorship from complete user records.
function authorship(fullPath, size) {
  if (size > WHOLE_SCAN_CAP) return null;
  let text;
  try { text = fs.readFileSync(fullPath, 'utf8'); } catch (_) { return null; }
  const out = { human: false, sdk: false, stream: false };
  for (const line of text.split('\n')) {
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (!obj || obj.type !== 'user') continue;
    if ((obj.origin && obj.origin.kind === 'human') || obj.promptSource === 'typed') out.human = true;
    if (obj.promptSource === 'sdk') {
      out.sdk = true;
      if (Array.isArray(obj.message && obj.message.content)) out.stream = true;
    }
  }
  return out;
}

// How a transcript opened and what kind of run it is.
//   receipt: a queue receipt with no assistant turn, shadowing a real session.
//   oneShot: every prompt came from a print run and no person typed a turn.
function scanTranscript(fullPath, size) {
  const headComplete = size <= HEAD_BYTES;
  const out = { startedISO: '', userMessage: '', queueContent: '', originalCwd: '', headComplete, receipt: false, oneShot: false };
  let sawAssistant = false;
  let sawUserLine = false;
  let human = false;
  let sdk = false;
  let stream = false;
  let text = '';
  try { text = readHead(fullPath, HEAD_BYTES); } catch (_) {}
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'assistant') sawAssistant = true;
    if (!out.startedISO && obj.timestamp) out.startedISO = obj.timestamp;
    if (!out.originalCwd && typeof obj.cwd === 'string') out.originalCwd = obj.cwd;
    if (obj.type === 'user') {
      sawUserLine = true;
      const content = obj.message ? obj.message.content : null;
      const originKind = obj.origin && typeof obj.origin === 'object' ? obj.origin.kind : null;
      if (originKind === 'human' || obj.promptSource === 'typed') human = true;
      else if (obj.promptSource === 'sdk') {
        sdk = true;
        if (Array.isArray(content)) stream = true;
      }
      if (!out.userMessage) {
        if (typeof content === 'string') out.userMessage = withoutContext(content).trim();
        else if (Array.isArray(content)) {
          const t = content.find((p) => p && p.type === 'text' && typeof p.text === 'string');
          if (t) out.userMessage = withoutContext(t.text).trim();
        }
      }
    }
    if (!out.queueContent && obj.type === 'queue-operation' && typeof obj.content === 'string') {
      out.queueContent = withoutContext(obj.content).trim();
    }
  }
  out.receipt = headComplete && !sawAssistant;
  if (out.receipt || human || stream) return out;
  if (headComplete) { out.oneShot = sdk; return out; }
  // A first line longer than the head hides its own marks, and a chat can open
  // with a print-style context turn, so a larger file is read whole.
  if (sdk || !sawUserLine) {
    const a = authorship(fullPath, size);
    out.oneShot = !!a && a.sdk && !a.human && !a.stream;
  }
  return out;
}

// Chats under projectsDir, newest file first, up to cap. `reads` returns a
// per-file-version scratch object so an unchanged file is classified once;
// `accept` lets the caller drop an entry before it counts toward the cap.
function listClaudeTranscripts(projectsDir, { cap = 300, reads = () => ({}), accept = () => true } = {}) {
  let projects = [];
  try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch (_) { return []; }
  const candidates = [];
  for (const proj of projects) {
    const projPath = path.join(projectsDir, proj.name);
    let files = [];
    try { files = fs.readdirSync(projPath); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fullPath = path.join(projPath, f);
      let st;
      try { st = fs.statSync(fullPath); } catch (_) { continue; }
      if (!st.isFile() || st.size === 0) continue;
      candidates.push({ id: f.slice(0, -6), project: proj.name, fullPath, st });
    }
  }
  candidates.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const out = [];
  for (const c of candidates) {
    if (out.length >= cap) break;
    const rc = reads(c.fullPath, c.st);
    c.scan = rc.scan || (rc.scan = scanTranscript(c.fullPath, c.st.size));
    if (c.scan.receipt) continue;
    if (!accept(c)) continue;
    out.push(c);
  }
  return out;
}

// The folder a path really names, through any links. A folder that is gone
// resolves through its nearest existing parent.
const realPathCache = new Map();
const REAL_PATH_CACHE_MAX = 4000;
function realPath(p) {
  const key = String(p || '');
  if (!key) return '';
  const hit = realPathCache.get(key);
  if (hit && Date.now() - hit.at < 15000) return hit.path;
  let head = path.resolve(key);
  let tail = '';
  let out = head;
  for (;;) {
    try { out = path.join(fs.realpathSync(head), tail); break; } catch (_) {}
    const up = path.dirname(head);
    if (up === head) break;
    tail = path.join(path.basename(head), tail);
    head = up;
  }
  if (realPathCache.size >= REAL_PATH_CACHE_MAX) realPathCache.clear();
  realPathCache.set(key, { path: out, at: Date.now() });
  return out;
}

module.exports = { HEAD_BYTES, WHOLE_SCAN_CAP, scanTranscript, listClaudeTranscripts, realPath };
