"use client";

import type { PhaseEntry, AlgorithmCriterion } from "@/types/algorithm";

interface SessionVelocitySparklineProps {
  phaseHistory: PhaseEntry[];
  criteria: AlgorithmCriterion[];
  isActive: boolean;
  width?: number;
  height?: number;
}

/**
 * Widget 1: SessionVelocitySparkline
 *
 * Inline SVG sparkline showing cumulative criteria completion over time.
 * Designed to fit inside session cards — compact and information-dense.
 */
export default function SessionVelocitySparkline({
  phaseHistory,
  criteria,
  isActive,
  width = 120,
  height = 32,
}: SessionVelocitySparklineProps) {
  const totalCriteria = criteria.length;

  if (totalCriteria === 0 || phaseHistory.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="shrink-0"
      >
        <line
          x1={0}
          y1={height - 2}
          x2={width}
          y2={height - 2}
          stroke="currentColor"
          className="text-ink-3"
          strokeWidth={1}
          strokeDasharray="2 4"
        />
      </svg>
    );
  }

  // Build data points: cumulative criteria count at each phase boundary
  const now = Date.now();
  const startTime = phaseHistory[0].startedAt;
  const endTime = isActive ? now : (phaseHistory[phaseHistory.length - 1].completedAt ?? now);
  const timeSpan = endTime - startTime;

  // Padding to keep the line away from exact edges
  const padX = 4;
  const padY = 3;
  const plotWidth = width - padX * 2;
  const plotHeight = height - padY * 2;

  // Build cumulative points from phase history
  const points: { x: number; y: number }[] = [];

  // Start at origin
  points.push({ x: padX, y: padY + plotHeight });

  let cumulativeCriteria = 0;
  for (let i = 0; i < phaseHistory.length; i++) {
    const phase = phaseHistory[i];
    cumulativeCriteria += phase.criteriaCount;

    const phaseEndTime = phase.completedAt ?? (isActive && i === phaseHistory.length - 1 ? now : phase.startedAt);
    const timeFraction = timeSpan > 0 ? (phaseEndTime - startTime) / timeSpan : 1;
    const x = padX + timeFraction * plotWidth;
    const y = padY + plotHeight - (totalCriteria > 0 ? (cumulativeCriteria / totalCriteria) * plotHeight : 0);

    points.push({ x: Math.min(x, padX + plotWidth), y: Math.max(y, padY) });
  }

  // Build polyline string
  const linePoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Build fill polygon (close path along the bottom)
  const lastPoint = points[points.length - 1];
  const firstPoint = points[0];
  const fillPoints =
    linePoints +
    ` ${lastPoint.x.toFixed(1)},${(padY + plotHeight).toFixed(1)}` +
    ` ${firstPoint.x.toFixed(1)},${(padY + plotHeight).toFixed(1)}`;

  const lineColor = isActive ? "#60a5fa" : "#34d399"; // blue-400 / emerald-400
  const fillColor = isActive ? "rgba(96, 165, 250, 0.10)" : "rgba(52, 211, 153, 0.10)";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      aria-label={`Velocity sparkline: ${cumulativeCriteria} of ${totalCriteria} criteria completed`}
    >
      {/* Area fill under curve */}
      <polygon points={fillPoints} fill={fillColor} />

      {/* Main line */}
      <polyline
        points={linePoints}
        fill="none"
        stroke={lineColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Leading edge dot */}
      {isActive && (
        <circle
          cx={lastPoint.x}
          cy={lastPoint.y}
          r={2.5}
          fill={lineColor}
          className="animate-pulse"
        />
      )}

      {/* Completed terminal dot */}
      {!isActive && (
        <circle
          cx={lastPoint.x}
          cy={lastPoint.y}
          r={2}
          fill={lineColor}
        />
      )}
    </svg>
  );
}
