"use client";

/**
 * System Health (Doctor) — read-only diagnostic surface over the advisory
 * capability manifest + heartbeat written by LIFEOS/TOOLS/Doctor.ts, plus the
 * hook reconciler. DIAGNOSTIC REGISTER ONLY: no scores, no percentages, no
 * meters. Declined renders calm ("off (declined)"), never red. A dead checker
 * (heartbeat > 7 days) is rendered loud/red, because a silent checker hides
 * every regression behind it.
 */

import { useQuery } from "@tanstack/react-query";
import { Stethoscope, Wrench } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/chrome";

type CapState = "live" | "broken" | "declined" | "stale";

interface Capability {
  id: string;
  title: string;
  state: CapState;
  detail: string;
  fixCmd: string | null;
  checkedAt: string;
  ttlHours: number;
  probeClass: string;
  stale: boolean;
}

interface DoctorData {
  manifest:
    | { present: true; updatedAt: string | null; capabilities: Capability[] }
    | { present: false; hint: string; capabilities: unknown[] };
  heartbeat:
    | { present: true; ranAt: string | null; network: boolean; ageMs: number | null; stale7d: boolean }
    | { present: false; hint: string };
  reconcile: { unwired: string[]; missing: string[]; note: string };
}

// state → { glyph, color, label }. Stale (a live entry past its TTL) reads as a
// calm hollow marker, not an error. Declined is calm and never red.
function stateFace(cap: Capability): { glyph: string; color: string; label: string } {
  if (cap.state === "declined") return { glyph: "⏸", color: "var(--ink-3)", label: "off (declined)" };
  if (cap.state === "broken") return { glyph: "❌", color: "var(--err)", label: "broken" };
  if (cap.stale) return { glyph: "◌", color: "var(--ink-3)", label: "stale — re-run doctor" };
  if (cap.state === "live") return { glyph: "✅", color: "var(--ok)", label: "live" };
  return { glyph: "◌", color: "var(--ink-3)", label: "stale — re-run doctor" };
}

function humanizeAge(ms: number | null): string {
  if (ms == null) return "unknown";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function SystemHealthPanel() {
  const { data, isError } = useQuery<DoctorData>({
    queryKey: ["doctor-state"],
    queryFn: async () => {
      const res = await fetch("/api/doctor");
      if (!res.ok) throw new Error("Failed to fetch doctor state");
      return res.json();
    },
    staleTime: 30_000,
  });

  if (isError) {
    return (
      <Panel>
        <PanelHeader title="System Health" icon={Stethoscope} />
        <p className="text-[13px] text-ink-3" style={{ fontFamily: "'concourse-t3', sans-serif" }}>
          Doctor surface unavailable.
        </p>
      </Panel>
    );
  }

  if (!data) {
    return (
      <Panel>
        <PanelHeader title="System Health" icon={Stethoscope} />
        <p className="text-[13px] text-ink-3" style={{ fontFamily: "'concourse-t3', sans-serif" }}>
          Loading…
        </p>
      </Panel>
    );
  }

  const { manifest, heartbeat, reconcile } = data;
  const hbAge = heartbeat.present ? humanizeAge(heartbeat.ageMs) : null;
  const hbRed = heartbeat.present && heartbeat.stale7d;

  return (
    <Panel>
      <PanelHeader
        title="System Health"
        icon={Stethoscope}
        meta={
          heartbeat.present ? (
            <span style={{ color: hbRed ? "var(--err)" : "var(--ink-3)" }}>
              doctor last ran {hbAge}
              {heartbeat.network ? " · network" : ""}
              {hbRed ? " — checker may be dead" : ""}
            </span>
          ) : undefined
        }
      />

      {/* Heartbeat absent — no doctor run yet */}
      {!heartbeat.present && (
        <p className="mb-4 text-[13px]" style={{ fontFamily: "'concourse-t3', sans-serif", color: "var(--warn)" }}>
          {heartbeat.hint}
        </p>
      )}

      {/* Capabilities */}
      {!manifest.present ? (
        <p className="text-[13px]" style={{ fontFamily: "'concourse-t3', sans-serif", color: "var(--ink-3)" }}>
          {manifest.hint}
        </p>
      ) : manifest.capabilities.length === 0 ? (
        <p className="text-[13px]" style={{ fontFamily: "'concourse-t3', sans-serif", color: "var(--ink-3)" }}>
          No capabilities probed yet — bun LIFEOS/TOOLS/Doctor.ts
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {manifest.capabilities.map((cap) => {
            const face = stateFace(cap);
            return (
              <div
                key={cap.id}
                className="flex items-start gap-3 rounded-lg px-3 py-2 bg-surface-3/40 border border-line-2"
              >
                <span className="text-[15px] leading-5 shrink-0" style={{ color: face.color }} aria-hidden>
                  {face.glyph}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[13px] leading-snug text-ink-1 flex-1 min-w-0 truncate"
                      style={{ fontFamily: "'concourse-t3', sans-serif" }}
                    >
                      {cap.title}
                    </span>
                    <span className="text-[12px] leading-snug shrink-0 ml-auto" style={{ color: face.color }}>
                      {face.label}
                    </span>
                  </div>
                  {cap.state !== "declined" && cap.detail && (
                    <div className="text-[12px] leading-snug text-ink-3 mt-1" style={{ fontFamily: "'concourse-t3', sans-serif" }}>
                      {cap.detail}
                    </div>
                  )}
                  {cap.state === "broken" && cap.fixCmd && (
                    <div className="flex items-start gap-1.5 mt-1">
                      <Wrench className="w-3 h-3 shrink-0 mt-0.5 text-ink-3" />
                      <code className="text-[12px] mono text-ink-2 break-all">{cap.fixCmd}</code>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Hook reconciliation */}
      <div className="mt-4 pt-3 border-t border-line-2">
        <div
          className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3 mb-2"
          style={{ fontFamily: "'concourse-c3', 'concourse-t3', sans-serif" }}
        >
          Hook reconciliation
        </div>
        {reconcile.unwired.length === 0 && reconcile.missing.length === 0 ? (
          <p className="text-[13px]" style={{ fontFamily: "'concourse-t3', sans-serif", color: "var(--ok)" }}>
            ✅ hooks fully reconciled — every declared hook is registered
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {reconcile.unwired.length > 0 && (
              <div>
                <span className="text-[12px]" style={{ color: "var(--warn)" }}>
                  declared on disk but not registered ({reconcile.unwired.length}):
                </span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {reconcile.unwired.map((f) => (
                    <code key={f} className="text-[12px] mono text-ink-2 px-1.5 py-0.5 rounded bg-surface-3/60 border border-line-2">
                      {f}
                    </code>
                  ))}
                </div>
              </div>
            )}
            {reconcile.missing.length > 0 && (
              <div>
                <span className="text-[12px]" style={{ color: "var(--err)" }}>
                  registered but missing from disk ({reconcile.missing.length}):
                </span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {reconcile.missing.map((f) => (
                    <code key={f} className="text-[12px] mono text-ink-2 px-1.5 py-0.5 rounded bg-surface-3/60 border border-line-2">
                      {f}
                    </code>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
