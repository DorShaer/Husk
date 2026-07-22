/**
 * claude-session adapter — LifeOS work activity since the last poll, read from the
 * existing event-sourced work registry (MEMORY/STATE/work-events.jsonl). This is the
 * highest-signal "creation" source and it already exists — Conduit consumes it, it
 * does not reimplement it. Read-only; never throws.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_ROOT } from "../paths.ts";
import { readState, writeState } from "../store.ts";
import type { ConduitEvent } from "../types.ts";

const WORK_EVENTS = join(CLAUDE_ROOT, "LIFEOS", "MEMORY", "STATE", "work-events.jsonl");

export function capture(): ConduitEvent[] {
  try {
    if (!existsSync(WORK_EVENTS)) return [];
    const cursor = (readState().lastClaudeCursor as string) || "";
    let latestTs = cursor;
    let count = 0;
    let lastSlug: string | undefined;

    for (const line of readFileSync(WORK_EVENTS, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let ev: { ts?: string; slug?: string };
      try {
        ev = JSON.parse(t);
      } catch {
        continue;
      }
      if (!ev.ts || (cursor && ev.ts <= cursor)) continue;
      count++;
      if (ev.slug) lastSlug = ev.slug;
      if (ev.ts > latestTs) latestTs = ev.ts;
    }

    if (count === 0) return [];
    writeState({ lastClaudeCursor: latestTs });
    return [
      {
        ts: new Date().toISOString(),
        type: "claude-session",
        source: "claudeSession",
        detail: { events: count, lastSlug },
      },
    ];
  } catch {
    return [];
  }
}
