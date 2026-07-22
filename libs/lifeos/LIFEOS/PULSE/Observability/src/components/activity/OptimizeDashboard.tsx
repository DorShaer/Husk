"use client";

import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import SessionCard from "./SessionCard";
import ModeBadge from "./ModeBadge";
import EffortBadge from "./EffortBadge";
import PresetBadge from "./PresetBadge";
import { TrendingUp, FlaskConical, Target, ShieldCheck, BarChart3, SlidersHorizontal } from "lucide-react";

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

export default function OptimizeDashboard() {
  const { algorithmStates, isLoading } = useAlgorithmState();

  const optimizeSessions = algorithmStates.filter(
    (s) => s.mode === "optimize"
  );

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse text-ink-3 text-sm">Loading...</div>
      </div>
    );
  }

  if (optimizeSessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="bg-white/[0.03] p-6 rounded-2xl mb-4 inline-block">
            <TrendingUp size={40} className="text-ink-3" />
          </div>
          <p className="text-base font-medium text-ink-2 mb-1">No optimize sessions</p>
          <p className="text-sm text-ink-3">Optimization runs will appear here when you use optimize mode</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {optimizeSessions.map((session) => {
        const elapsed = session.algorithmStartedAt
          ? formatElapsed(Date.now() - session.algorithmStartedAt)
          : "";
        const isStale = session.algorithmStartedAt
          ? Date.now() - session.algorithmStartedAt > 15 * 60 * 1000
          : false;
        const completedCriteria = session.criteria?.filter(c => c.status === "completed").length ?? 0;
        const totalCriteria = session.criteria?.length ?? 0;
        const guardRails = session.criteria?.filter(c => c.type === "anti-criterion") ?? [];
        const guardRailsPassing = guardRails.filter(c => c.status !== "failed").length;

        return (
          <div
            key={session.sessionId}
            className={`rounded-xl border p-4 space-y-3 ${
              isStale
                ? "border-amber-500/20 bg-amber-500/[0.02]"
                : "border-white/[0.06] bg-white/[0.02]"
            }`}
          >
            {/* Header */}
            <div className="flex items-center gap-3">
              {isStale ? (
                <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
              ) : (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
              )}
              <ModeBadge mode="optimize" size="compact" />
              {session.algorithmConfig && (
                <PresetBadge preset={session.algorithmConfig.preset} mode="optimize" />
              )}
              <span className="text-base font-medium text-ink-1 truncate flex-1 min-w-0 uppercase tracking-wide">
                {session.taskDescription || session.sessionId?.slice(0, 8)}
              </span>
              {session.effortLevel && <EffortBadge effort={session.effortLevel} />}
              <span className="text-sm text-ink-3 font-mono tabular-nums">{elapsed}</span>
            </div>

            {/* Metrics Row */}
            <div className="grid grid-cols-4 gap-3">
              {/* Phase */}
              <div className="bg-white/[0.03] rounded-lg p-3">
                <div className="flex items-center gap-1.5 text-xs text-ink-3 mb-1">
                  <BarChart3 size={12} />
                  Phase
                </div>
                <div className="text-sm font-medium text-ink-1">
                  {session.currentPhase || "IDLE"}
                </div>
              </div>

              {/* Experiments (criteria as proxy) */}
              <div className="bg-white/[0.03] rounded-lg p-3">
                <div className="flex items-center gap-1.5 text-xs text-ink-3 mb-1">
                  <FlaskConical size={12} />
                  Criteria
                </div>
                <div className="text-sm font-medium text-ink-1">
                  {completedCriteria}/{totalCriteria}
                </div>
              </div>

              {/* Target */}
              <div className="bg-white/[0.03] rounded-lg p-3">
                <div className="flex items-center gap-1.5 text-xs text-ink-3 mb-1">
                  <Target size={12} />
                  Rework
                </div>
                <div className="text-sm font-medium text-ink-1">
                  {session.reworkCount ?? 0}
                </div>
              </div>

              {/* Guard Rails */}
              <div className="bg-white/[0.03] rounded-lg p-3">
                <div className="flex items-center gap-1.5 text-xs text-ink-3 mb-1">
                  <ShieldCheck size={12} />
                  Guard Rails
                </div>
                <div className={`text-sm font-medium ${
                  guardRails.length === 0
                    ? "text-ink-3"
                    : guardRailsPassing === guardRails.length
                    ? "text-emerald-400"
                    : "text-red-400"
                }`}>
                  {guardRails.length === 0 ? "—" : `${guardRailsPassing}/${guardRails.length}`}
                </div>
              </div>
            </div>

            {/* Optimize Params */}
            {session.algorithmConfig?.params && (() => {
              const p = session.algorithmConfig.params;
              return (
                <div className="grid grid-cols-3 gap-3">
                  {p.stepSize != null && (
                    <div className="bg-white/[0.03] rounded-lg p-2">
                      <div className="flex items-center gap-1">
                        <SlidersHorizontal className="w-2.5 h-2.5 text-ink-3" />
                        <div className="text-[13px] text-ink-3 uppercase tracking-wider">Step Size</div>
                      </div>
                      <div className="text-sm font-mono text-ink-1">{Number(p.stepSize).toFixed(2)}</div>
                    </div>
                  )}
                  {p.regressionTolerance != null && (
                    <div className="bg-white/[0.03] rounded-lg p-2">
                      <div className="flex items-center gap-1">
                        <SlidersHorizontal className="w-2.5 h-2.5 text-ink-3" />
                        <div className="text-[13px] text-ink-3 uppercase tracking-wider">Regression Tol.</div>
                      </div>
                      <div className="text-sm font-mono text-ink-1">{Number(p.regressionTolerance).toFixed(2)}</div>
                    </div>
                  )}
                  {p.earlyStopPatience != null && (
                    <div className="bg-white/[0.03] rounded-lg p-2">
                      <div className="flex items-center gap-1">
                        <SlidersHorizontal className="w-2.5 h-2.5 text-ink-3" />
                        <div className="text-[13px] text-ink-3 uppercase tracking-wider">Early Stop</div>
                      </div>
                      <div className="text-sm font-mono text-ink-1">{p.earlyStopPatience}</div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Criteria List */}
            {session.criteria && session.criteria.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs text-ink-3 font-medium uppercase tracking-wide px-1">Criteria</div>
                {session.criteria.slice(0, 10).map((c) => (
                  <div key={c.id} className="flex items-center gap-2 px-1 py-0.5">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      c.status === "completed" ? "bg-emerald-500" :
                      c.status === "failed" ? "bg-red-500" :
                      c.status === "in_progress" ? "bg-amber-500" :
                      "bg-line-3"
                    }`} />
                    <span className={`text-sm truncate ${
                      c.type === "anti-criterion" ? "text-red-400/80 italic" : "text-ink-2"
                    }`}>
                      {c.description}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
