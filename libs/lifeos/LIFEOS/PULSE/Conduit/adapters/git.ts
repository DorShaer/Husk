/**
 * git-commit adapter — new commits across configured repos since the last poll.
 *
 * execFile (no shell). Each repo is isolated in its own try/catch so one bad path
 * never blocks the others. Commits carry their author-date as the event timestamp,
 * so they file under the day they were actually made.
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { ConduitConfig } from "../config.ts";
import { readState, writeState } from "../store.ts";
import type { ConduitEvent } from "../types.ts";

const UNIT = "\x1f"; // ASCII unit separator — safe field delimiter for --pretty

export function capture(config: ConduitConfig): ConduitEvent[] {
  if (!config.repos.length) return [];
  const state = readState();
  const since =
    (state.lastGitPollTs as string) ||
    new Date(Date.now() - config.pollIntervalSec * 2000).toISOString();
  const events: ConduitEvent[] = [];
  let allOk = true;

  for (const repo of config.repos) {
    try {
      const out = execFileSync(
        "git",
        ["-C", repo, "log", `--since=${since}`, "--no-merges", `--pretty=format:%H${UNIT}%s${UNIT}%aI`],
        { encoding: "utf8", timeout: 8000 },
      ).trim();
      if (!out) continue;
      for (const line of out.split("\n")) {
        const [sha, subject, authorDate] = line.split(UNIT);
        if (!sha) continue;
        events.push({
          ts: authorDate || new Date().toISOString(),
          type: "git-commit",
          source: "git",
          repo: basename(repo),
          detail: { sha: sha.slice(0, 10), subject },
        });
      }
    } catch {
      allOk = false; // failed scan — keep polling the rest, but do NOT advance the cursor
    }
  }

  // Only advance the cursor when EVERY repo scanned cleanly, so a transient failure never
  // skips commits in the un-scanned window. The re-scan overlap is de-duped by SHA at rollup.
  if (allOk) writeState({ lastGitPollTs: new Date().toISOString() });
  return events;
}
