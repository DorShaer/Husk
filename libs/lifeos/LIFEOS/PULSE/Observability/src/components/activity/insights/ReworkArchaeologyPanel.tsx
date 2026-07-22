"use client";

import { useState, useMemo } from "react";
import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import { ChevronDown, RefreshCw } from "lucide-react";
import type { AlgorithmState, ReworkCycle, PhaseEntry } from "@/types/algorithm";

// ─── Widget 9: Rework Archaeology Panel ───
// Shows sessions that required rework, with iteration history.
// Each rework session rendered as a stacked "retry stack" of cards.

function formatDuration(ms: number): string {
  if (ms < 0 || isNaN(ms)) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return remainMin > 0 ? `${hr}h ${remainMin}m` : `${hr}h`;
}

function totalElapsedFromPhaseHistory(phases: PhaseEntry[]): number {
  if (phases.length === 0) return 0;
  const start = phases[0].startedAt;
  const last = phases[phases.length - 1];
  const end = last.completedAt ?? Date.now();
  return end - start;
}

interface ReworkSession {
  session: AlgorithmState;
  reworkCount: number;
  totalElapsed: number;
  totalCriteria: number;
  passedCriteria: number;
}

function collectReworkSessions(states: AlgorithmState[]): ReworkSession[] {
  const results: ReworkSession[] = [];

  for (const session of states) {
    const reworkCount = session.reworkCount ?? 0;
    const hasRework = reworkCount > 0 || (session.reworkHistory && session.reworkHistory.length > 0);

    if (!hasRework) continue;

    const totalElapsed = totalElapsedFromPhaseHistory(session.phaseHistory ?? []);
    const totalCriteria = session.criteria?.length ?? 0;
    const passedCriteria = session.criteria?.filter((c) => c.status === "completed").length ?? 0;

    results.push({
      session,
      reworkCount: reworkCount || (session.reworkHistory?.length ?? 0),
      totalElapsed,
      totalCriteria,
      passedCriteria,
    });
  }

  // Sort by reworkCount descending
  results.sort((a, b) => b.reworkCount - a.reworkCount);
  return results;
}

export default function ReworkArchaeologyPanel() {
  const { algorithmStates, isLoading, error } = useAlgorithmState();

  const reworkSessions = useMemo(
    () => collectReworkSessions(algorithmStates),
    [algorithmStates]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        Loading rework data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-40 text-rose-400 text-xs">
        Error: {error}
      </div>
    );
  }

  if (reworkSessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        No rework sessions — clean runs only!
      </div>
    );
  }

  const avgIterations =
    reworkSessions.length > 0
      ? (
          reworkSessions.reduce((sum, s) => sum + s.reworkCount, 0) /
          reworkSessions.length
        ).toFixed(1)
      : "0";

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="text-xs text-ink-2">
        <span className="font-mono font-medium text-amber-400">
          {reworkSessions.length}
        </span>{" "}
        sessions required rework, avg{" "}
        <span className="font-mono font-medium text-amber-400">
          {avgIterations}
        </span>{" "}
        iterations
      </div>

      {/* Rework session cards */}
      {reworkSessions.map((rs, i) => (
        <ReworkStack key={`${rs.session.sessionId}-${i}`} rework={rs} />
      ))}
    </div>
  );
}

function ReworkStack({ rework }: { rework: ReworkSession }) {
  const { session, reworkCount, totalElapsed, totalCriteria, passedCriteria } = rework;
  const [expanded, setExpanded] = useState(false);

  // Build stacked visual layers (max 5 visible layers)
  const layerCount = Math.min(reworkCount, 4);
  const opacitySteps = [20, 40, 60, 80];

  return (
    <div className="relative">
      {/* Background stacked layers */}
      {Array.from({ length: layerCount }, (_, i) => (
        <div
          key={i}
          className="absolute rounded-lg border border-amber-500/10 bg-amber-900/5"
          style={{
            top: `${(layerCount - i) * 4}px`,
            left: `${(layerCount - i) * 2}px`,
            right: `${(layerCount - i) * 2}px`,
            bottom: `-${(layerCount - i) * 4}px`,
            opacity: opacitySteps[i] ? opacitySteps[i] / 100 : 0.2,
            zIndex: i,
          }}
        />
      ))}

      {/* Top visible card */}
      <div
        className="relative bg-[rgba(20,28,56,0.6)] rounded-lg border border-amber-500/20 p-3 space-y-2"
        style={{ zIndex: layerCount + 1 }}
      >
        <div className="flex items-start justify-between gap-3">
          {/* Left side: session info */}
          <div className="flex-1 min-w-0 space-y-1">
            <p className="text-[16px] font-bold text-ink-1 truncate">
              {session.taskDescription || session.sessionId}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Iteration badge */}
              <span className="text-[13px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">
                Attempt {reworkCount + 1}
              </span>
              {/* Criteria count */}
              <span className="text-[13px] text-ink-3 font-mono">
                {passedCriteria}/{totalCriteria} criteria
              </span>
            </div>
          </div>

          {/* Right side: iteration number + elapsed */}
          <div className="flex flex-col items-end shrink-0">
            <span className="text-2xl font-mono font-bold text-amber-400 leading-none">
              {reworkCount}
            </span>
            <span className="text-[13px] text-ink-3 font-mono mt-1">
              {formatDuration(totalElapsed)}
            </span>
          </div>
        </div>

        {/* Rework history (collapsible) */}
        {session.reworkHistory && session.reworkHistory.length > 0 && (
          <div>
            <button
              onClick={() => setExpanded((e) => !e)}
              className="flex items-center gap-1.5 w-full text-left group"
            >
              <RefreshCw className="w-3 h-3 text-amber-500/60 shrink-0" />
              <span className="text-[14px] text-ink-2 group-hover:text-ink-1 transition-colors">
                Iteration history ({session.reworkHistory.length} cycles)
              </span>
              <ChevronDown
                className={`w-3 h-3 text-ink-3 ml-auto transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
            {expanded && (
              <div className="mt-2 space-y-1.5 pl-4">
                {session.reworkHistory.map((cycle: ReworkCycle, i: number) => (
                  <ReworkCycleRow key={i} cycle={cycle} index={i} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReworkCycleRow({ cycle, index }: { cycle: ReworkCycle; index: number }) {
  const elapsed = cycle.completedAt - cycle.startedAt;
  const criteriaCount = cycle.criteria?.length ?? 0;
  const passedCount = cycle.criteria?.filter((c) => c.status === "completed").length ?? 0;

  return (
    <div className="flex items-center justify-between text-[13px] py-1 border-b border-white/[0.03] last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="font-mono text-amber-400/80">#{index + 1}</span>
        <span className="text-ink-2">
          {passedCount}/{criteriaCount} criteria
        </span>
        <span className="text-ink-3">
          {cycle.fromPhase} &rarr; {cycle.toPhase}
        </span>
      </div>
      <span className="text-ink-3 font-mono">{formatDuration(elapsed)}</span>
    </div>
  );
}
