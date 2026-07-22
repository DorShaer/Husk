"use client";

import { useState } from "react";
import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import type { AlgorithmState, AlgorithmPhase, PhaseEntry } from "@/types/algorithm";

/**
 * Widget 4: PhaseRhythmStrip
 *
 * Horizontal stacked bars showing phase durations for each algorithm session.
 * Sessions stacked vertically, newest on top, max 10 shown.
 */

const PHASE_COLORS: Record<string, string> = {
  OBSERVE: "#7dcfff",
  THINK: "#bb9af7",
  PLAN: "#7aa2f7",
  BUILD: "#ff9e64",
  EXECUTE: "#9ece6a",
  VERIFY: "#73daca",
  LEARN: "#e0af68",
};

const PHASE_ORDER: AlgorithmPhase[] = [
  "OBSERVE",
  "THINK",
  "PLAN",
  "BUILD",
  "EXECUTE",
  "VERIFY",
  "LEARN",
];

interface PhaseSegment {
  phase: AlgorithmPhase;
  duration: number;
  startOffset: number;
}

function getPhaseSegments(phaseHistory: PhaseEntry[]): PhaseSegment[] {
  const segments: PhaseSegment[] = [];
  let offset = 0;

  for (const entry of phaseHistory) {
    // Skip IDLE and COMPLETE phases
    if (entry.phase === "IDLE" || entry.phase === "COMPLETE") continue;

    const start = entry.startedAt;
    const end = entry.completedAt ?? Date.now();
    const duration = Math.max(end - start, 0);

    segments.push({
      phase: entry.phase,
      duration,
      startOffset: offset,
    });

    offset += duration;
  }

  return segments;
}

function isAlgorithmSession(session: AlgorithmState): boolean {
  const mode = session.currentMode ?? session.mode;
  if (mode === "native" || mode === "minimal") return false;
  if (session.phaseHistory && session.phaseHistory.length > 0) return true;
  if (session.criteria && session.criteria.length > 0) return true;
  return mode === "interactive" || mode === "starting" || mode === "algorithm";
}

function getSessionName(session: AlgorithmState): string {
  if (session.taskDescription) {
    return session.taskDescription.replace(/^\[Telegram\]\s*/, "");
  }
  return session.sessionId?.slice(0, 12) || "Unknown";
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function isActivePhase(session: AlgorithmState, entry: PhaseEntry): boolean {
  return (
    session.active === true &&
    !entry.completedAt &&
    entry.phase === session.currentPhase
  );
}

interface TooltipInfo {
  phase: string;
  duration: string;
  x: number;
  y: number;
}

export default function PhaseRhythmStrip() {
  const { algorithmStates, isLoading } = useAlgorithmState();
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  // Filter to algorithm sessions and sort by start time (newest first), max 10
  const sessions = algorithmStates
    .filter(isAlgorithmSession)
    .filter((s) => s.phaseHistory && s.phaseHistory.length > 0)
    .sort((a, b) => (b.algorithmStartedAt || 0) - (a.algorithmStartedAt || 0))
    .slice(0, 10);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-[160px] h-4 bg-surface-2 rounded animate-pulse" />
            <div className="flex-1 h-7 bg-surface-2 rounded animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        No algorithm sessions with phase data
      </div>
    );
  }

  const BAR_HEIGHT = 28;
  const LABEL_WIDTH = 160;

  return (
    <div className="space-y-1 relative">
      {sessions.map((session) => {
        const segments = getPhaseSegments(session.phaseHistory || []);
        const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);

        if (totalDuration === 0) return null;

        return (
          <div key={session.sessionId} className="flex items-center gap-3">
            {/* Session name column */}
            <div
              className="shrink-0 truncate text-right"
              style={{ width: LABEL_WIDTH }}
              title={getSessionName(session)}
            >
              <span className="text-[14px] text-ink-2">
                {getSessionName(session)}
              </span>
            </div>

            {/* Stacked bar */}
            <div
              className="flex-1 relative rounded overflow-hidden"
              style={{ height: BAR_HEIGHT }}
            >
              <svg
                width="100%"
                height={BAR_HEIGHT}
                className="block"
                preserveAspectRatio="none"
              >
                {segments.map((seg, idx) => {
                  const xPercent =
                    totalDuration > 0
                      ? (seg.startOffset / totalDuration) * 100
                      : 0;
                  const widthPercent =
                    totalDuration > 0
                      ? (seg.duration / totalDuration) * 100
                      : 0;

                  const color = PHASE_COLORS[seg.phase] || "var(--ink-3)";
                  const phaseEntry = (session.phaseHistory || [])[idx];
                  const isActive = phaseEntry
                    ? isActivePhase(session, phaseEntry)
                    : false;

                  return (
                    <g key={`${seg.phase}-${idx}`}>
                      <rect
                        x={`${xPercent}%`}
                        y={0}
                        width={`${widthPercent}%`}
                        height={BAR_HEIGHT}
                        fill={color}
                        opacity={0.85}
                        className="cursor-default"
                        onMouseEnter={(e) => {
                          const rect = (
                            e.target as SVGRectElement
                          ).getBoundingClientRect();
                          setTooltip({
                            phase: seg.phase,
                            duration: formatDuration(seg.duration),
                            x: rect.left + rect.width / 2,
                            y: rect.top,
                          });
                        }}
                        onMouseLeave={() => setTooltip(null)}
                      >
                        {isActive && (
                          <animate
                            attributeName="opacity"
                            values="0.85;0.5;0.85"
                            dur="2s"
                            repeatCount="indefinite"
                          />
                        )}
                      </rect>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        );
      })}

      {/* Legend */}
      <div className="flex items-center gap-4 pt-2 pl-[172px]">
        {PHASE_ORDER.map((phase) => (
          <div key={phase} className="flex items-center gap-1.5">
            <div
              className="w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: PHASE_COLORS[phase] }}
            />
            <span className="text-[13px] text-ink-3">{phase}</span>
          </div>
        ))}
      </div>

      {/* Tooltip (portal-style via fixed positioning) */}
      {tooltip && (
        <div
          className="fixed z-50 px-2.5 py-1.5 rounded-md bg-surface-2 border border-white/[0.08] shadow-lg pointer-events-none"
          style={{
            left: tooltip.x,
            top: tooltip.y - 40,
            transform: "translateX(-50%)",
          }}
        >
          <p className="text-xs text-ink-1 font-medium">{tooltip.phase}</p>
          <p className="text-[13px] text-ink-2 font-mono">
            {tooltip.duration}
          </p>
        </div>
      )}
    </div>
  );
}
