"use client";

import { useState } from "react";
import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import type { EffortLevel } from "@/types/algorithm";

/**
 * Widget 10: EffortDistributionDonut
 *
 * SVG donut chart showing session effort level distribution.
 * Uses stroke-dasharray technique on circles for segments.
 * No external charting libraries.
 */

const EFFORT_LEVELS: EffortLevel[] = [
  "Native",
  "Standard",
  "Extended",
  "Advanced",
  "Deep",
  "Comprehensive",
];

const EFFORT_COLORS: Record<EffortLevel, { tailwind: string; hex: string }> = {
  Native: { tailwind: "bg-amber-500", hex: "#f59e0b" },
  Standard: { tailwind: "bg-blue-400", hex: "#60a5fa" },
  Extended: { tailwind: "bg-violet-400", hex: "#a78bfa" },
  Advanced: { tailwind: "bg-purple-400", hex: "#c084fc" },
  Deep: { tailwind: "bg-amber-500", hex: "#f59e0b" },
  Comprehensive: { tailwind: "bg-rose-400", hex: "#fb7185" },
};

interface DonutSegment {
  level: EffortLevel;
  count: number;
  percentage: number;
  color: string;
  offset: number;
}

function buildSegments(
  counts: Map<EffortLevel, number>,
  total: number
): DonutSegment[] {
  const segments: DonutSegment[] = [];
  let cumulativeOffset = 0;

  for (const level of EFFORT_LEVELS) {
    const count = counts.get(level) ?? 0;
    if (count === 0) continue;

    const percentage = (count / total) * 100;
    segments.push({
      level,
      count,
      percentage,
      color: EFFORT_COLORS[level].hex,
      offset: cumulativeOffset,
    });
    cumulativeOffset += percentage;
  }

  return segments;
}

export default function EffortDistributionDonut() {
  const { algorithmStates, isLoading } = useAlgorithmState();
  const [hoveredSegment, setHoveredSegment] = useState<DonutSegment | null>(null);

  // Count sessions by effort level (include both active and completed)
  const counts = new Map<EffortLevel, number>();
  for (const session of algorithmStates) {
    const level = session.effortLevel || session.sla;
    if (level && EFFORT_LEVELS.includes(level as EffortLevel)) {
      counts.set(level as EffortLevel, (counts.get(level as EffortLevel) ?? 0) + 1);
    }
  }

  const total = Array.from(counts.values()).reduce((sum, v) => sum + v, 0);
  const segments = buildSegments(counts, total);

  // SVG donut parameters
  const size = 180;
  const center = size / 2;
  const strokeWidth = 28;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  // Rotation to start from top (-90deg)
  const rotationOffset = -90;

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="flex items-center justify-center h-[240px]">
          <div className="w-[180px] h-[180px] rounded-full border-4 border-line-2 animate-pulse" />
        </div>
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Effort Distribution
        </h3>
        <div className="flex flex-col items-center justify-center py-8">
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="#27272a"
              strokeWidth={strokeWidth}
            />
            <text
              x={center}
              y={center}
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-[var(--ink-3)]"
              fontSize={14}
            >
              No data
            </text>
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
      <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
        Effort Distribution
      </h3>

      <div className="flex flex-col items-center">
        {/* Donut chart */}
        <div className="relative">
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="transform"
            style={{ transform: `rotate(${rotationOffset}deg)` }}
          >
            {/* Background track */}
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="#27272a"
              strokeWidth={strokeWidth}
            />

            {/* Segments */}
            {segments.map((segment) => {
              const dashLength = (segment.percentage / 100) * circumference;
              const gapLength = circumference - dashLength;
              const dashOffset = -(segment.offset / 100) * circumference;

              return (
                <circle
                  key={segment.level}
                  cx={center}
                  cy={center}
                  r={radius}
                  fill="none"
                  stroke={segment.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${dashLength} ${gapLength}`}
                  strokeDashoffset={dashOffset}
                  strokeLinecap="butt"
                  className="transition-opacity duration-150"
                  style={{
                    opacity:
                      hoveredSegment && hoveredSegment.level !== segment.level
                        ? 0.4
                        : 1,
                  }}
                  onMouseEnter={() => setHoveredSegment(segment)}
                  onMouseLeave={() => setHoveredSegment(null)}
                />
              );
            })}
          </svg>

          {/* Center text (not rotated) */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            {hoveredSegment ? (
              <>
                <span className="text-2xl font-semibold text-white tabular-nums">
                  {hoveredSegment.count}
                </span>
                <span className="text-[14px] text-ink-2">
                  {hoveredSegment.percentage.toFixed(0)}% {hoveredSegment.level}
                </span>
              </>
            ) : (
              <>
                <span className="text-[32px] font-semibold text-white leading-none tabular-nums">
                  {total}
                </span>
                <span className="text-[14px] text-ink-2 mt-0.5">sessions</span>
              </>
            )}
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 mt-4">
          {segments.map((segment) => (
            <div
              key={segment.level}
              className="flex items-center gap-1.5 cursor-default"
              onMouseEnter={() => setHoveredSegment(segment)}
              onMouseLeave={() => setHoveredSegment(null)}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: segment.color }}
              />
              <span className="text-[14px] text-ink-2">
                {segment.level}
              </span>
              <span className="text-[14px] text-ink-3 font-mono tabular-nums">
                {segment.count}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
