/**
 * Append-only event store + small durable state, both under USER.
 * JSONL append is atomic enough for single-line writes; no locking needed for a
 * single-writer launchd poll.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVENTS_DIR, STATE_PATH, dailyPathsFor, eventsPathFor } from "./paths.ts";
import type { ConduitEvent } from "./types.ts";

/** Local calendar date (YYYY-MM-DD) for a Date, in the machine's timezone. */
export function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Append one event to its day's log. Creates the events dir on first write. */
export function appendEvent(e: ConduitEvent): void {
  mkdirSync(EVENTS_DIR, { recursive: true });
  const date = localDate(new Date(e.ts));
  appendFileSync(eventsPathFor(date), JSON.stringify(e) + "\n");
}

/** Parse JSONL text into events, tolerating and COUNTING corrupt/torn lines. Pure. */
export function parseEventLines(text: string): { events: ConduitEvent[]; dropped: number } {
  const events: ConduitEvent[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t) as ConduitEvent);
    } catch {
      dropped++; // torn/corrupt line — durability over strictness
    }
  }
  return { events, dropped };
}

/** Read all events for a day. Missing file → []; corrupt lines skipped, never thrown. */
export function readDayEvents(date: string): ConduitEvent[] {
  const path = eventsPathFor(date);
  if (!existsSync(path)) return [];
  return parseEventLines(readFileSync(path, "utf8")).events;
}

type ConduitState = Record<string, unknown>;

/** Read durable adapter state (last-poll cursors, last rollup date, etc.). */
export function readState(): ConduitState {
  try {
    if (!existsSync(STATE_PATH)) return {};
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as ConduitState;
  } catch {
    return {};
  }
}

const STATE_LOCK = `${STATE_PATH}.lock`;

/**
 * Cross-process critical section via atomic mkdir. Best-effort: after a bounded wait it
 * proceeds anyway (a stale lock never wedges the poll), and the atomic tmp+rename write
 * below still guarantees no reader ever sees a torn file.
 */
function withStateLock<T>(fn: () => T): T {
  const deadline = Date.now() + 2000;
  let held = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(STATE_LOCK); // atomic — throws if the lock dir already exists
      held = true;
      break;
    } catch {
      Bun.sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        rmdirSync(STATE_LOCK);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Merge-write durable state under a cross-process lock, atomically (tmp + rename). The
 * lock stops a manual run and a launchd poll from clobbering each other's cursors via
 * read-modify-write; the rename stops any reader seeing a half-written state.json.
 */
export function writeState(patch: ConduitState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  withStateLock(() => {
    const next = { ...readState(), ...patch };
    const tmp = `${STATE_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, STATE_PATH);
  });
}

/** Pure guard: prune a day only if it's older than cutoff AND its daily record exists. */
export function prunable(date: string, cutoff: string, hasDailyRecord: boolean): boolean {
  return date < cutoff && hasDailyRecord;
}

/** True iff a parseable daily JSON record exists for the date. */
function hasValidDailyRecord(date: string): boolean {
  try {
    const p = dailyPathsFor(date).json;
    if (!existsSync(p)) return false;
    JSON.parse(readFileSync(p, "utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete raw event logs older than `retentionDays` — the "raw discarded" guarantee —
 * but NEVER for a day lacking a confirmed daily record. This guard is what prevents a
 * missed rollup from becoming a silent, permanent hole in attention history.
 * Returns the number of day-logs removed.
 */
export function pruneOldEvents(retentionDays: number): number {
  if (!existsSync(EVENTS_DIR) || retentionDays <= 0) return 0;
  const cutoff = localDate(new Date(Date.now() - retentionDays * 86_400_000));
  let removed = 0;
  for (const f of readdirSync(EVENTS_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    if (!prunable(m[1], cutoff, hasValidDailyRecord(m[1]))) continue;
    try {
      rmSync(join(EVENTS_DIR, f));
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/** Sorted list of dates (YYYY-MM-DD) that have a raw event log. */
export function listEventDates(): string[] {
  if (!existsSync(EVENTS_DIR)) return [];
  return readdirSync(EVENTS_DIR)
    .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort();
}

/** True iff a parseable daily record exists for the date. */
export function dailyRecordExists(date: string): boolean {
  return hasValidDailyRecord(date);
}
