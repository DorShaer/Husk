/**
 * app-focus adapter — the foreground application at poll time.
 *
 * Uses `osascript` via execFile (argument array, never a shell string — no
 * interpolation, per the security protocol). Captures the app NAME only, no window
 * title (window titles need Screen Recording permission; deferred to v1.1). Cheap:
 * one ~50ms osascript call per poll. Never throws — returns [] on any failure.
 */
import { execFileSync } from "node:child_process";
import type { ConduitConfig } from "../config.ts";
import type { ConduitEvent } from "../types.ts";

const FRONT_APP_SCRIPT =
  'tell application "System Events" to get name of first application process whose frontmost is true';

export function capture(config: ConduitConfig): ConduitEvent[] {
  try {
    const app = execFileSync("osascript", ["-e", FRONT_APP_SCRIPT], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (!app) return [];
    // Pin the interval this span represents onto the event, so rollup values it at the
    // interval in effect at capture time — not whatever the config says later.
    return [
      {
        ts: new Date().toISOString(),
        type: "app-focus",
        source: "appFocus",
        app,
        detail: { intervalSec: config.pollIntervalSec },
      },
    ];
  } catch {
    return [];
  }
}
