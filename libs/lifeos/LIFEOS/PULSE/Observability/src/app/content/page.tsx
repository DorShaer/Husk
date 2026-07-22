"use client";

import { useEffect, useRef, useState } from "react";
import { PageShell, PageHeader, Panel, Pill, dimStyle, type Dim } from "@/components/ui/chrome";

// ── CONVEYOR: the live content board. Dense cards, SSE push, poll fallback. ──

interface Item {
  id: string;
  title: string;
  type: string;
  stage: string;
  legs: Record<string, string>;
  stage_status?: string;
  activity?: string;
  activity_at?: string;
  blocked?: boolean;
  attempt?: number;
  requested_run?: string;
  created: string;
}
interface BoardData {
  columns: string[];
  legs: string[];
  items: Item[];
  counts: Record<string, number>;
}

// Status → design-token dimension. running=blue, done=ok, failed=err, changes=warn.
function legDim(s: string): Dim {
  return (
    { pending: "neutral", running: "blue", done: "ok", failed: "err", "changes-requested": "warn" } as Record<string, Dim>
  )[s] ?? "neutral";
}
function elapsed(fromISO?: string, nowMs = Date.now()): string {
  if (!fromISO) return "";
  const s = Math.max(0, Math.round((nowMs - Date.parse(fromISO)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

export default function ContentPage() {
  const [data, setData] = useState<BoardData | null>(null);
  const [live, setLive] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    const startPoll = () => {
      if (pollRef.current) return;
      const load = async () => {
        try {
          const r = await fetch("/api/content", { cache: "no-store" });
          if (r.ok) setData(await r.json());
        } catch {
          /* keep last frame */
        }
      };
      load();
      pollRef.current = setInterval(load, 2500);
    };
    try {
      es = new EventSource("/api/content/stream");
      es.onmessage = (ev) => {
        try {
          setData(JSON.parse(ev.data));
          setLive(true);
        } catch {
          /* ignore */
        }
      };
      es.onerror = () => {
        setLive(false);
        es?.close();
        startPoll();
      };
    } catch {
      startPoll();
    }
    return () => {
      es?.close();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const columns = data?.columns ?? ["inbox", "prep", "produce", "review", "publishing", "done"];

  return (
    <PageShell>
      <style>{`
        @keyframes conv-pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.3; transform:scale(.8); } }
        @keyframes conv-glow { 0%,100% { box-shadow: 0 0 0 1px var(--accent-blue); } 50% { box-shadow: 0 0 0 1px var(--accent-blue), 0 0 12px -3px var(--accent-blue); } }
        @keyframes conv-shim { 0% { background-position:-160% 0; } 100% { background-position:160% 0; } }
        .conv-run { animation: conv-glow 1.6s ease-in-out infinite; }
        .conv-dot { animation: conv-pulse 1.1s ease-in-out infinite; }
        .conv-bar { background:linear-gradient(90deg,transparent,var(--accent-blue),transparent); background-size:200% 100%; animation:conv-shim 1.4s linear infinite; }
        .conv-x { color:var(--ink-3); cursor:pointer; transition:color .15s ease; background:none; border:none; font-family:inherit; }
        .conv-x:hover { color:var(--err); }
      `}</style>

      <PageHeader
        title="Content"
        subtitle="drop → transcribe → produce (edit+augment · clips 2–16 · social · omny · discord) → review → publish"
        actions={
          <>
            <Pill dim={live ? "ok" : "neutral"}>
              <span
                className={live ? "conv-dot" : undefined}
                style={{ width: 6, height: 6, borderRadius: 999, background: live ? "var(--ok)" : "var(--ink-3)" }}
              />
              {live ? "LIVE" : "POLLING"}
            </Pill>
            <span className="text-[12px] text-ink-3 mono">{data ? `${data.items.length}` : "…"}</span>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns.length}, minmax(0,1fr))`, gap: 8 }}>
        {columns.map((col) => {
          const items = (data?.items ?? []).filter((it) => (it.stage ?? "inbox") === col);
          return (
            <Panel key={col} className="p-2 min-h-[calc(100vh-220px)]" style={{ background: "var(--surface-1)" }}>
              <div
                className="text-[10px] tracking-[0.16em] px-0.5 pt-0.5 pb-2"
                style={{ color: items.length ? "var(--accent-blue)" : "var(--ink-3)" }}
              >
                {col.toUpperCase()} <span className="text-ink-3">{items.length}</span>
              </div>
              {items.map((it) => {
                const running = it.stage_status === "running";
                const failed = it.stage_status === "failed" || it.blocked;
                const done = it.stage_status === "done";
                const dot = `var(--${running ? "accent-blue" : failed ? "err" : done ? "ok" : "ink-3"})`;
                const statusLabel = running ? "RUNNING" : failed ? "BLOCKED" : done ? "READY" : "IDLE";
                const border = running
                  ? "var(--accent-blue)"
                  : failed
                    ? "var(--err)"
                    : done
                      ? "rgba(74,222,128,0.4)"
                      : "var(--line-2)";
                return (
                  <Panel
                    key={it.id}
                    className={`p-3 mb-2 relative overflow-hidden ${running ? "conv-run" : ""}`}
                    style={{ borderColor: border }}
                  >
                    {running && <div className="conv-bar" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2 }} />}

                    {/* Title row */}
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
                      <span className={running ? "conv-dot" : undefined} style={{ width: 7, height: 7, borderRadius: 999, background: dot, flex: "0 0 auto", marginTop: 4 }} />
                      <span className="text-ink-1" style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3, flex: 1, minWidth: 0, wordBreak: "break-word" }}>{it.title}</span>
                      <button
                        type="button"
                        className="conv-x"
                        title="Delete item — stops its tasks"
                        aria-label={`Delete ${it.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Delete "${it.title}" and stop its tasks?`)) {
                            fetch(`/api/content/${it.id}`, { method: "DELETE" });
                          }
                        }}
                        style={{ fontSize: 15, lineHeight: 1, padding: "0 2px", flex: "0 0 auto" }}
                      >
                        ×
                      </button>
                    </div>

                    {/* Meta row: type · status · elapsed */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", margin: "8px 0 2px", paddingLeft: 14 }}>
                      <Pill dim="neutral" className="uppercase">{it.type}</Pill>
                      <span style={{ fontSize: 9.5, letterSpacing: "0.08em", color: dot, fontWeight: 600 }}>{statusLabel}</span>
                      {it.requested_run ? (
                        <Pill dim="blue">RUN QUEUED</Pill>
                      ) : (
                        !["review", "publishing", "done"].includes(it.stage) && (
                          <button
                            type="button"
                            title="Queue the regular run: edit → augment → clips → social (staged, never auto-published)"
                            onClick={(e) => {
                              e.stopPropagation();
                              fetch(`/api/content/${it.id}/run`, { method: "POST" });
                            }}
                            className="rounded-full text-[12px] font-medium cursor-pointer"
                            style={{ ...dimStyle("blue", true), padding: "1px 8px", fontFamily: "inherit" }}
                          >
                            ▶ RUN
                          </button>
                        )
                      )}
                      {(running || done) && it.activity_at && (
                        <span className="text-ink-3" style={{ fontSize: 9.5 }}>{elapsed(it.activity_at, nowMs)}</span>
                      )}
                      {failed && it.attempt ? <span style={{ fontSize: 9.5, color: "var(--err)" }}>try {it.attempt}</span> : null}
                    </div>

                    {/* Activity line */}
                    {it.activity && (
                      <div
                        style={{ fontSize: 10.5, color: running ? "var(--accent-blue)" : failed ? "var(--err)" : "var(--ink-3)", margin: "3px 0 0", paddingLeft: 14, lineHeight: 1.35, wordBreak: "break-word" }}
                      >
                        {it.activity}
                      </div>
                    )}

                    {/* Divider */}
                    <div className="bg-line-2" style={{ height: 1, margin: "9px 0 8px", marginLeft: 14 }} />

                    {/* Per-leg labeled chips */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, paddingLeft: 14 }}>
                      {Object.entries(it.legs ?? {}).map(([leg, status]) => {
                        const d = legDim(status);
                        return (
                          <Pill key={leg} dim={d} title={`${leg}: ${status}`}>
                            <span style={{ width: 5, height: 5, borderRadius: 999, background: `var(--${d === "blue" ? "accent-blue" : d === "neutral" ? "ink-3" : d})` }} />
                            {leg}
                          </Pill>
                        );
                      })}
                    </div>
                  </Panel>
                );
              })}
            </Panel>
          );
        })}
      </div>
    </PageShell>
  );
}
