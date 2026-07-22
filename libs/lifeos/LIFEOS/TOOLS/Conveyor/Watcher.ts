/**
 * Conveyor Watcher — drop-in ingestion for the content pipeline (P1).
 *
 * The SOLE ledger writer in P1 (single-writer discipline: watcher writes,
 * Pulse reads). Watches the inbox folder, applies a quiescence gate (size
 * stable for a window — large recordings copy slowly and fs events fire
 * mid-copy), then registers the item in the content ledger with all
 * derivative legs 'pending'.
 *
 * Mechanics:
 *   - fs.watch for responsiveness + periodic rescan for missed events +
 *     startup rescan for files already present.
 *   - Quiescence: a candidate's stableSince starts at min(now, mtime) — a
 *     file untouched since before the window ingests immediately on rescan;
 *     a growing file waits until its size stops changing.
 *   - Idempotency: content_hash (sha256 over size + first 8MB); a hash
 *     already in the ledger never re-registers.
 *   - Sidecar: `<file>.md` beside the drop overrides title/type via
 *     simple `key: value` lines.
 *
 * CLI:  bun Watcher.ts          run the watch loop
 *       bun Watcher.ts --once   single scan pass, then exit (synthetic probes)
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  watch,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { appendEvents, findByHash, newItemEvent, readState } from './Ledger';

export const INBOX_DIR =
  process.env.CONVEYOR_INBOX || join(homedir(), 'Recordings', 'Inbox');
export const QUIESCENCE_MS = Number(process.env.CONVEYOR_QUIESCENCE_MS || 10_000);
const POLL_MS = 2_000;
const RESCAN_MS = 15_000;
const HASH_HEAD_BYTES = 8 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  '.mov': 'video', '.mp4': 'video', '.m4v': 'video', '.mkv': 'video', '.webm': 'video',
  '.m4a': 'audio', '.wav': 'audio', '.mp3': 'audio', '.aiff': 'audio', '.flac': 'audio',
};

// ── Quiescence gate (pure — tested in Watcher.test.ts) ─────────────────────

export interface Candidate {
  size: number;
  stableSince: number; // epoch ms when the current size was first observed
}

/** Fold one (size, mtime) sample into candidate state. */
export function updateCandidate(
  prev: Candidate | undefined,
  size: number,
  mtimeMs: number,
  now: number,
): Candidate {
  if (!prev || prev.size !== size) return { size, stableSince: Math.min(now, mtimeMs) };
  return prev;
}

/** Quiescent when the size has been stable for the full window. */
export function isQuiescent(c: Candidate, now: number, windowMs = QUIESCENCE_MS): boolean {
  return now - c.stableSince >= windowMs;
}

// ── Sidecar + classification ───────────────────────────────────────────────

/** Parse `key: value` lines from a sidecar markdown file. */
export function parseSidecar(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

export function isEligible(name: string): boolean {
  if (name.startsWith('.')) return false;
  return extOf(name) in MEDIA_TYPES;
}

/** sha256 over "<size>\n" + first 8MB — fast and stable for multi-GB media. */
export function contentHash(path: string): string {
  const size = statSync(path).size;
  const h = createHash('sha256');
  h.update(`${size}\n`);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, HASH_HEAD_BYTES));
    if (buf.length > 0) {
      const read = readSync(fd, buf, 0, buf.length, 0);
      h.update(buf.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

// ── Ingest ─────────────────────────────────────────────────────────────────

function ingest(path: string): 'registered' | 'duplicate' {
  const hash = contentHash(path);
  if (findByHash(readState(), hash)) return 'duplicate';
  const name = basename(path);
  let title = name.replace(/\.[^.]+$/, '');
  let type = MEDIA_TYPES[extOf(name)] ?? 'unknown';
  const sidecarPath = `${path}.md`;
  const extra: Record<string, unknown> = {};
  if (existsSync(sidecarPath)) {
    const sc = parseSidecar(readFileSync(sidecarPath, 'utf-8'));
    if (sc.title) title = sc.title;
    if (sc.type) type = sc.type;
    extra.sidecar = sc;
  }
  appendEvents([
    newItemEvent({ id: hash.slice(0, 12), path, title, type, content_hash: hash, src: 'watcher', extra }),
  ]);
  console.log(`[conveyor-watcher] registered ${name} (${hash.slice(0, 12)})`);
  return 'registered';
}

// ── Watch loop ─────────────────────────────────────────────────────────────

const candidates = new Map<string, Candidate>();

function scanPass(now = Date.now()): void {
  let names: string[] = [];
  try {
    names = readdirSync(INBOX_DIR);
  } catch {
    return;
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (!isEligible(name)) continue;
    const path = join(INBOX_DIR, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;
    seen.add(path);
    const cand = updateCandidate(candidates.get(path), st.size, st.mtimeMs, now);
    candidates.set(path, cand);
    if (isQuiescent(cand, now)) {
      try {
        ingest(path);
      } catch (err) {
        console.error(`[conveyor-watcher] ingest failed for ${name}: ${err}`);
        continue;
      }
      candidates.delete(path);
    }
  }
  for (const path of candidates.keys()) if (!seen.has(path)) candidates.delete(path);
}

function main(): void {
  mkdirSync(INBOX_DIR, { recursive: true });
  const once = process.argv.includes('--once');
  scanPass();
  if (once) {
    console.log(`[conveyor-watcher] --once pass complete (${candidates.size} pending quiescence)`);
    return;
  }
  console.log(`[conveyor-watcher] watching ${INBOX_DIR} (quiescence ${QUIESCENCE_MS}ms)`);
  try {
    watch(INBOX_DIR, () => scanPass());
  } catch {
    /* poll loop below is the fallback */
  }
  setInterval(() => scanPass(), POLL_MS);
  setInterval(() => scanPass(), RESCAN_MS);
}

if (import.meta.main) main();
