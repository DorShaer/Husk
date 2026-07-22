"use client";

import { useState, useMemo } from "react";
import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import type { AlgorithmPhase, PhaseEntry } from "@/types/algorithm";

/**
 * Widget 13: PhaseBottleneckAnalyzer
 *
 * Horizontal bar chart showing average/median/max duration per phase
 * across all sessions. Identifies bottleneck phases.
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

const PHASE_ICONS: Record<string, string> = {
  OBSERVE: "\u{1F441}",
  THINK: "\u{1F9E0}",
  PLAN: "\u{1F4CB}",
  BUILD: "\u{1F528}",
  EXECUTE: "\u{26A1}",
  VERIFY: "\u{2705}",
  LEARN: "\u{1F4DA}",
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

interface PhaseStats {
  phase: AlgorithmPhase;
  median: number;
  average: number;
  max: number;
  count: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computePhaseStats(
  allPhaseEntries: PhaseEntry[]
): Map<AlgorithmPhase, PhaseStats> {
  const durationsByPhase = new Map<AlgorithmPhase, number[]>();

  for (const phase of PHASE_ORDER) {
    durationsByPhase.set(phase, []);
  }

  for (const entry of allPhaseEntries) {
    if (entry.phase === "IDLE" || entry.phase === "COMPLETE") continue;
    if (!PHASE_ORDER.includes(entry.phase)) continue;

    const start = entry.startedAt;
    const end = entry.completedAt ?? Date.now();
    const duration = Math.max(end - start, 0);

    if (duration > 0) {
      const existing = durationsByPhase.get(entry.phase) || [];
      existing.push(duration);
      durationsByPhase.set(entry.phase, existing);
    }
  }

  const stats = new Map<AlgorithmPhase, PhaseStats>();

  for (const phase of PHASE_ORDER) {
    const durations = durationsByPhase.get(phase) || [];

    if (durations.length === 0) {
      stats.set(phase, { phase, median: 0, average: 0, max: 0, count: 0 });
      continue;
    }

    const sum = durations.reduce((a, b) => a + b, 0);
    stats.set(phase, {
      phase,
      median: median(durations),
      average: sum / durations.length,
      max: Math.max(...durations),
      count: durations.length,
    });
  }

  return stats;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const secs = seconds % 60;
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Scale labels and positions for the x-axis
const SCALE_TICKS = [
  { ms: 0, label: "0s" },
  { ms: 30_000, label: "30s" },
  { ms: 60_000, label: "60s" },
  { ms: 120_000, label: "2m" },
  { ms: 300_000, label: "5m" },
  { ms: 600_000, label: "10m" },
];

interface TooltipInfo {
  phase: string;
  median: string;
  average: string;
  max: string;
  count: number;
  x: number;
  y: number;
}

export default function PhaseBottleneckAnalyzer() {
  const { algorithmStates, isLoading } = useAlgorithmState();
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  // Collect all phase entries across all sessions
  const allPhaseEntries = useMemo(() => {
    const entries: PhaseEntry[] = [];
    for (const session of algorithmStates) {
      if (session.phaseHistory) {
        entries.push(...session.phaseHistory);
      }
      // Also include workHistory phases
      if (session.workHistory) {
        for (const work of session.workHistory) {
          if (work.phaseHistory) {
            entries.push(...work.phaseHistory);
          }
        }
      }
    }
    return entries;
  }, [algorithmStates]);

  const statsMap = useMemo(
    () => computePhaseStats(allPhaseEntries),
    [allPhaseEntries]
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-20 h-4 bg-surface-2 rounded animate-pulse" />
            <div className="flex-1 h-5 bg-surface-2 rounded animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  const hasAnyData = PHASE_ORDER.some(
    (p) => (statsMap.get(p)?.count ?? 0) > 0
  );

  if (!hasAnyData) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        No phase duration data available
      </div>
    );
  }

  // Find the slowest phase by average
  let slowestPhase = "";
  let slowestAvg = 0;
  for (const phase of PHASE_ORDER) {
    const s = statsMap.get(phase);
    if (s && s.average > slowestAvg) {
      slowestAvg = s.average;
      slowestPhase = phase;
    }
  }

  // Determine the max value across all stats for scaling
  const globalMax = Math.max(
    ...PHASE_ORDER.map((p) => statsMap.get(p)?.max ?? 0),
    60_000 // Minimum scale of 60s
  );

  // Add 10% padding
  const scaleMax = globalMax * 1.1;

  // SVG dimensions
  const SVG_HEIGHT = 7 * 36 + 40; // 7 rows of 36px each + axis
  const LABEL_WIDTH = 90;
  const LEFT_PAD = LABEL_WIDTH + 10;
  const RIGHT_PAD = 20;
  const ROW_HEIGHT = 36;
  const BAR_HEIGHT = 16;
  const AXIS_Y = 7 * ROW_HEIGHT + 8;

  function xPos(ms: number): number {
    // Linear scale
    const fraction = Math.min(ms / scaleMax, 1);
    // Return as percentage of available width (we'll use viewBox)
    return LEFT_PAD + fraction * (1000 - LEFT_PAD - RIGHT_PAD);
  }

  const budgetX = xPos(60_000);

  return (
    <div className="relative">
      {/* Summary stat */}
      <div className="mb-3 text-xs text-ink-2">
        Slowest phase:{" "}
        <span
          className="font-medium"
          style={{ color: PHASE_COLORS[slowestPhase] }}
        >
          {slowestPhase}
        </span>{" "}
        <span className="text-ink-3 font-mono">
          (avg {formatDuration(slowestAvg)})
        </span>
      </div>

      <svg
        viewBox={`0 0 1000 ${SVG_HEIGHT}`}
        className="w-full"
        style={{ height: "auto" }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Budget line at 60s */}
        <line
          x1={budgetX}
          y1={0}
          x2={budgetX}
          y2={AXIS_Y}
          stroke="var(--line-1)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <text
          x={budgetX}
          y={AXIS_Y + 28}
          textAnchor="middle"
          className="text-[13px]"
          fill="var(--ink-3)"
          fontSize={20}
        >
          budget
        </text>

        {/* Phase rows */}
        {PHASE_ORDER.map((phase, rowIndex) => {
          const stats = statsMap.get(phase);
          const y = rowIndex * ROW_HEIGHT;
          const barY = y + (ROW_HEIGHT - BAR_HEIGHT) / 2;
          const color = PHASE_COLORS[phase] || "var(--ink-3)";
          const icon = PHASE_ICONS[phase] || "";

          if (!stats || stats.count === 0) {
            return (
              <g key={phase}>
                {/* Label */}
                <text
                  x={LEFT_PAD - 14}
                  y={y + ROW_HEIGHT / 2 + 5}
                  textAnchor="end"
                  fill="var(--ink-3)"
                  fontSize={20}
                >
                  {icon} {phase}
                </text>
                <text
                  x={LEFT_PAD + 8}
                  y={y + ROW_HEIGHT / 2 + 5}
                  fill="var(--line-1)"
                  fontSize={18}
                >
                  No data
                </text>
              </g>
            );
          }

          const medianX = xPos(stats.median);
          const avgX = xPos(stats.average);
          const maxX = xPos(stats.max);
          const isOutlier = stats.max > 2 * stats.median;

          return (
            <g
              key={phase}
              className="cursor-default"
              onMouseEnter={(e) => {
                const svg = (
                  e.currentTarget.ownerSVGElement as SVGSVGElement
                ).getBoundingClientRect();
                setTooltip({
                  phase,
                  median: formatDuration(stats.median),
                  average: formatDuration(stats.average),
                  max: formatDuration(stats.max),
                  count: stats.count,
                  x: svg.left + svg.width / 2,
                  y: svg.top + (y / SVG_HEIGHT) * svg.height,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* Label */}
              <text
                x={LEFT_PAD - 14}
                y={y + ROW_HEIGHT / 2 + 5}
                textAnchor="end"
                fill={color}
                fontSize={20}
              >
                {icon} {phase}
              </text>

              {/* Median bar (solid fill) */}
              <rect
                x={LEFT_PAD}
                y={barY}
                width={Math.max(medianX - LEFT_PAD, 2)}
                height={BAR_HEIGHT}
                rx={3}
                fill={color}
                opacity={0.8}
              />

              {/* Average bar (outline/dashed) */}
              <rect
                x={LEFT_PAD}
                y={barY}
                width={Math.max(avgX - LEFT_PAD, 2)}
                height={BAR_HEIGHT}
                rx={3}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                opacity={0.5}
              />

              {/* Max extension (thin line) */}
              {stats.max > stats.average && (
                <line
                  x1={avgX}
                  y1={barY + BAR_HEIGHT / 2}
                  x2={maxX}
                  y2={barY + BAR_HEIGHT / 2}
                  stroke={color}
                  strokeWidth={2}
                  opacity={0.35}
                />
              )}

              {/* Outlier dot if max > 2x median */}
              {isOutlier && (
                <circle
                  cx={maxX}
                  cy={barY + BAR_HEIGHT / 2}
                  r={5}
                  fill="#fb7185"
                  opacity={0.9}
                />
              )}

              {/* Duration label after median bar */}
              <text
                x={medianX + 8}
                y={barY + BAR_HEIGHT / 2 + 5}
                fill="var(--ink-2)"
                fontSize={16}
              >
                {formatDuration(stats.median)}
              </text>
            </g>
          );
        })}

        {/* X-axis line */}
        <line
          x1={LEFT_PAD}
          y1={AXIS_Y}
          x2={1000 - RIGHT_PAD}
          y2={AXIS_Y}
          stroke="var(--line-1)"
          strokeWidth={1}
        />

        {/* X-axis tick labels */}
        {SCALE_TICKS.filter((tick) => tick.ms <= scaleMax).map((tick) => {
          const tickX = xPos(tick.ms);
          return (
            <g key={tick.label}>
              <line
                x1={tickX}
                y1={AXIS_Y}
                x2={tickX}
                y2={AXIS_Y + 6}
                stroke="var(--line-1)"
                strokeWidth={1}
              />
              <text
                x={tickX}
                y={AXIS_Y + 24}
                textAnchor="middle"
                fill="var(--ink-3)"
                fontSize={18}
              >
                {tick.label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 px-3 py-2 rounded-md bg-surface-2 border border-white/[0.08] shadow-lg pointer-events-none"
          style={{
            left: tooltip.x,
            top: tooltip.y - 10,
            transform: "translateX(-50%) translateY(-100%)",
          }}
        >
          <p
            className="text-xs font-medium mb-1"
            style={{ color: PHASE_COLORS[tooltip.phase] }}
          >
            {tooltip.phase}
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[13px]">
            <span className="text-ink-3">Median</span>
            <span className="text-ink-1 font-mono">{tooltip.median}</span>
            <span className="text-ink-3">Average</span>
            <span className="text-ink-1 font-mono">{tooltip.average}</span>
            <span className="text-ink-3">Max</span>
            <span className="text-ink-1 font-mono">{tooltip.max}</span>
            <span className="text-ink-3">Samples</span>
            <span className="text-ink-1 font-mono">{tooltip.count}</span>
          </div>
        </div>
      )}
    </div>
  );
}
