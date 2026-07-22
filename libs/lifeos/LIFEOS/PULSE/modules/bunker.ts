/**
 * Bunker module — feeds the Pulse "Bunker" tab.
 *
 * Bunker (~/Projects/bunker) is the source of truth. This module shells out to its
 * CLI (`bunker data`), caches the snapshot, and serves it at /api/bunker. Pulse only
 * displays; Bunker computes. CLI-as-contract keeps Pulse decoupled from bunker internals.
 *
 * Routes (all under /api/bunker):
 *   GET  /api/bunker          → { apps[], summary, lastFetch, stale }
 *   GET  /api/bunker/status   → module health
 *   POST /api/bunker/refresh  → force an immediate re-scan
 */

import { join } from "path";
import { existsSync } from "fs";

const HOME = process.env.HOME ?? "";
const MODULE = "bunker";
const BUNKER_DIR = process.env.BUNKER_DIR || join(HOME, "Projects", "bunker");
const BUNKER_BIN = join(BUNKER_DIR, "bin", "bunker.ts");

interface State {
  running: boolean;
  startedAt: Date | null;
  cache: any | null;
  lastFetch: Date | null;
  pollHandle: ReturnType<typeof setInterval> | null;
}

const state: State = { running: false, startedAt: null, cache: null, lastFetch: null, pollHandle: null };

async function refresh(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const proc = Bun.spawnSync(["bun", BUNKER_BIN, "data"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      return { ok: false, reason: `bunker data exit ${proc.exitCode}: ${proc.stderr.toString().slice(0, 200)}` };
    }
    state.cache = JSON.parse(proc.stdout.toString());
    state.lastFetch = new Date();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

export async function start(): Promise<void> {
  console.log(`[${MODULE}] Starting...`);
  state.running = true;
  state.startedAt = new Date();
  const r = await refresh();
  if (!r.ok) console.warn(`[${MODULE}] initial refresh failed: ${r.reason}`);
  state.pollHandle = setInterval(() => {
    refresh().catch((err) => console.error(`[${MODULE}] poll error: ${err}`));
  }, 60_000);
  console.log(`[${MODULE}] Polling ${BUNKER_BIN} every 60s`);
}

export async function stop(): Promise<void> {
  console.log(`[${MODULE}] Stopping...`);
  state.running = false;
  if (state.pollHandle) {
    clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
}

export function health(): { status: string; details?: Record<string, unknown> } {
  return {
    status: state.running ? "healthy" : "stopped",
    details: {
      apps: state.cache?.summary?.apps ?? 0,
      last_fetch: state.lastFetch?.toISOString() ?? null,
      bunker_dir: BUNKER_DIR,
    },
  };
}

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/bunker")) return null;
  const sub = pathname.replace(/^\/api\/bunker/, "") || "/";

  if (sub === "/status") return Response.json(health());

  if (req.method === "POST" && sub === "/refresh") {
    const r = await refresh();
    return Response.json({ ok: r.ok, reason: r.reason ?? null, lastFetch: state.lastFetch?.toISOString() ?? null });
  }

  // Serve an app's own social image / favicon so the console cards show real brand art.
  if (req.method === "GET" && sub.startsWith("/asset")) {
    const u = new URL(req.url);
    const appName = u.searchParams.get("app");
    const kind = u.searchParams.get("kind") === "favicon" ? "favicon.svg" : "og.png";
    const found = state.cache?.apps?.find((a: any) => a.name === appName);
    if (!found) return Response.json({ error: "unknown app" }, { status: 404 });
    const path = join(found.dir, "public", kind); // dir from trusted registry; filename whitelisted
    if (!existsSync(path)) return Response.json({ error: "no asset" }, { status: 404 });
    return new Response(Bun.file(path), { headers: { "Cache-Control": "public, max-age=300" } });
  }

  if (req.method === "GET" && (sub === "/" || sub === "")) {
    if (!state.cache) {
      return Response.json({
        apps: [],
        summary: { apps: 0, green: 0, probesPass: 0, probesTotal: 0, manual: 0 },
        lastFetch: null,
        stale: true,
        stale_reason: "no snapshot yet — first scan pending",
      });
    }
    return Response.json({ ...state.cache, lastFetch: state.lastFetch?.toISOString() ?? null });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
