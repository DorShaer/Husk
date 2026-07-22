/**
 * Deterministic daily rollup. PURE: buildDailyRecord takes events + poll interval and
 * returns a DailyRecord with zero side effects and zero model calls — which is what
 * makes v1 stable and testable. Persistence is a separate function.
 *
 * Time model: each app-focus event represents one poll interval of that app (capped —
 * a sleep gap does not inflate time because launchd fires no polls while asleep).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { classifyApp } from "./classify.ts";
import { DAILY_DIR, dailyPathsFor } from "./paths.ts";
import type { ConduitEvent, DailyBlock, DailyRecord } from "./types.ts";

/** Aggregate a day's raw events into the deterministic record. Pure. */
export function buildDailyRecord(
  date: string,
  events: ConduitEvent[],
  pollIntervalSec: number,
  conduitVersion: string,
): DailyRecord {
  const perAppSec = new Map<string, number>();
  const seenSha = new Set<string>();
  let commits = 0;
  let sessions = 0;

  for (const e of events) {
    if (e.type === "app-focus" && e.app) {
      // Pin duration to the interval in effect WHEN captured (falls back to the passed
      // default for events written before intervalSec was recorded). Changing the config
      // interval never retroactively re-values history.
      const sec = Number(e.detail?.intervalSec) || pollIntervalSec;
      perAppSec.set(e.app, (perAppSec.get(e.app) ?? 0) + sec);
    } else if (e.type === "git-commit") {
      const sha = (e.detail?.sha as string) || `${e.repo}:${e.ts}`;
      if (seenSha.has(sha)) continue; // de-dupe commits seen across overlapping poll windows
      seenSha.add(sha);
      commits++;
    } else if (e.type === "claude-session") {
      sessions++;
    }
  }

  const blocks: DailyBlock[] = [...perAppSec.entries()]
    .map(([label, sec]) => ({
      label,
      kind: classifyApp(label),
      minutes: Math.round((sec / 60) * 10) / 10,
    }))
    .sort((a, b) => b.minutes - a.minutes);

  const sum = (kind: string) =>
    Math.round(blocks.filter((b) => b.kind === kind).reduce((n, b) => n + b.minutes, 0) * 10) / 10;

  return {
    date,
    conduitVersion,
    generatedAt: new Date().toISOString(),
    totalMinutes: Math.round(blocks.reduce((n, b) => n + b.minutes, 0) * 10) / 10,
    creationMinutes: sum("creation"),
    consumptionMinutes: sum("consumption"),
    neutralMinutes: sum("neutral"),
    blocks,
    commits,
    sessions,
    narrative: null, // v2 local-model seam
    telosTags: {}, // v2 TELOS-scoring seam
  };
}

/** Render a record as human-readable markdown. */
export function renderMarkdown(r: DailyRecord): string {
  const hm = (m: number) => `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
  const ratio =
    r.creationMinutes + r.consumptionMinutes > 0
      ? Math.round((r.creationMinutes / (r.creationMinutes + r.consumptionMinutes)) * 100)
      : 0;
  const rows = r.blocks
    .slice(0, 20)
    .map((b) => `| ${b.label} | ${b.kind} | ${hm(b.minutes)} |`)
    .join("\n");
  return `# Conduit — ${r.date}

> Deterministic daily record · Conduit v${r.conduitVersion} · generated ${r.generatedAt}

- **Tracked time:** ${hm(r.totalMinutes)}
- **Creation:** ${hm(r.creationMinutes)} · **Consumption:** ${hm(r.consumptionMinutes)} · **Neutral:** ${hm(r.neutralMinutes)}
- **Creation ratio:** ${ratio}% (creation / (creation + consumption))
- **Commits:** ${r.commits} · **LifeOS sessions:** ${r.sessions}

## Where the time went

| App | Kind | Time |
|-----|------|------|
${rows || "| _(no app-focus events)_ | | |"}
`;
}

/** Write via tmp-file + atomic rename so a reader never sees a half-written file. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`; // pid-unique so concurrent rollups don't share a tmp
  writeFileSync(tmp, content);
  renameSync(tmp, path); // atomic on the same filesystem
}

/** Persist a record as markdown + JSON under USER, atomically. */
export function writeDailyRecord(r: DailyRecord): { md: string; json: string } {
  mkdirSync(DAILY_DIR, { recursive: true });
  const paths = dailyPathsFor(r.date);
  writeAtomic(paths.md, renderMarkdown(r));
  writeAtomic(paths.json, JSON.stringify(r, null, 2));
  return paths;
}
