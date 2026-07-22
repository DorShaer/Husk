"use client";

import { useState, useMemo } from "react";
import { useReflections } from "@/hooks/useObservabilityData";

/**
 * Widget 5: SatisfactionPulseMonitor
 *
 * Line chart showing implied sentiment (1-10) over recent sessions.
 * Color-coded segments: emerald >= 7, amber 4-6, rose < 4.
 * Running average overlay and current average display.
 */

interface ReflectionPoint {
  timestamp: number;
  sentiment: number;
  taskDescription: string;
}

function parseReflections(
  raw: Array<Record<string, unknown>>
): ReflectionPoint[] {
  const points: ReflectionPoint[] = [];

  for (const entry of raw) {
    const timestamp =
      typeof entry.timestamp === "string"
        ? new Date(entry.timestamp).getTime()
        : typeof entry.timestamp === "number"
          ? entry.timestamp
          : 0;

    const sentiment =
      typeof entry.implied_sentiment === "number"
        ? entry.implied_sentiment
        : typeof entry.implied_sentiment === "string"
          ? parseFloat(entry.implied_sentiment)
          : NaN;

    if (timestamp > 0 && !isNaN(sentiment) && sentiment >= 1 && sentiment <= 10) {
      points.push({
        timestamp,
        sentiment,
        taskDescription:
          typeof entry.task_description === "string"
            ? entry.task_description
            : "Unknown task",
      });
    }
  }

  // Sort by timestamp ascending
  points.sort((a, b) => a.timestamp - b.timestamp);
  return points;
}

function getSegmentColor(value: number): string {
  if (value >= 7) return "#34d399"; // emerald-400
  if (value >= 4) return "#fbbf24"; // amber-400
  return "#fb7185"; // rose-400
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const hour = d.getHours().toString().padStart(2, "0");
  const min = d.getMinutes().toString().padStart(2, "0");
  return `${month} ${day} ${hour}:${min}`;
}

interface TooltipInfo {
  task: string;
  sentiment: number;
  x: number;
  y: number;
}

// SVG constants
const SVG_WIDTH = 800;
const SVG_HEIGHT = 200;
const PAD_LEFT = 40;
const PAD_RIGHT = 20;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
const PLOT_WIDTH = SVG_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = SVG_HEIGHT - PAD_TOP - PAD_BOTTOM;

export default function SatisfactionPulseMonitor() {
  const { data, isLoading } = useReflections();
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  const reflections = useMemo(() => {
    if (!data?.reflections) return [];
    return parseReflections(data.reflections);
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <div className="w-full h-full bg-[rgba(20,28,56,0.5)] rounded animate-pulse" />
      </div>
    );
  }

  if (reflections.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-ink-3 text-xs">
        No reflection data yet
      </div>
    );
  }

  // Compute running average
  const runningAvg: number[] = [];
  let cumulativeSum = 0;
  for (let i = 0; i < reflections.length; i++) {
    cumulativeSum += reflections[i].sentiment;
    runningAvg.push(cumulativeSum / (i + 1));
  }

  const currentAvg =
    reflections.length > 0
      ? cumulativeSum / reflections.length
      : 0;

  // Time bounds
  const minTime = reflections[0].timestamp;
  const maxTime = reflections[reflections.length - 1].timestamp;
  const timeSpan = maxTime - minTime || 1; // Avoid division by zero

  // Map data point to SVG coordinates
  function toX(timestamp: number): number {
    return PAD_LEFT + ((timestamp - minTime) / timeSpan) * PLOT_WIDTH;
  }

  function toY(value: number): number {
    // Y axis: 1 at bottom, 10 at top
    return PAD_TOP + ((10 - value) / 9) * PLOT_HEIGHT;
  }

  // Build multi-colored line segments
  const lineSegments: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color: string;
  }> = [];

  const areaPoints: Array<{ x: number; y: number; color: string }> = [];

  for (let i = 0; i < reflections.length; i++) {
    const r = reflections[i];
    const x = toX(r.timestamp);
    const y = toY(r.sentiment);
    areaPoints.push({ x, y, color: getSegmentColor(r.sentiment) });

    if (i > 0) {
      const prev = reflections[i - 1];
      const px = toX(prev.timestamp);
      const py = toY(prev.sentiment);
      // Color by the destination point's value
      lineSegments.push({
        x1: px,
        y1: py,
        x2: x,
        y2: y,
        color: getSegmentColor(r.sentiment),
      });
    }
  }

  // Build running average polyline
  const avgPolyline = reflections
    .map((r, i) => {
      const x = toX(r.timestamp);
      const y = toY(runningAvg[i]);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Build area fill polygons (one per segment)
  const areaFillPaths: string[] = [];
  const bottomY = PAD_TOP + PLOT_HEIGHT;

  for (let i = 0; i < areaPoints.length; i++) {
    if (i > 0) {
      const prev = areaPoints[i - 1];
      const curr = areaPoints[i];
      areaFillPaths.push(
        `M${prev.x.toFixed(1)},${prev.y.toFixed(1)} L${curr.x.toFixed(1)},${curr.y.toFixed(1)} L${curr.x.toFixed(1)},${bottomY.toFixed(1)} L${prev.x.toFixed(1)},${bottomY.toFixed(1)} Z`
      );
    }
  }

  // Y-axis labels
  const yLabels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  // X-axis: show up to 5 evenly spaced time labels
  const xLabelCount = Math.min(reflections.length, 5);
  const xLabels: Array<{ timestamp: number; x: number }> = [];
  for (let i = 0; i < xLabelCount; i++) {
    const idx =
      xLabelCount <= 1
        ? 0
        : Math.round((i / (xLabelCount - 1)) * (reflections.length - 1));
    const r = reflections[idx];
    xLabels.push({ timestamp: r.timestamp, x: toX(r.timestamp) });
  }

  return (
    <div className="relative">
      {/* Current average display */}
      <div className="absolute top-0 right-0 z-10">
        <span
          className="text-[28px] font-bold font-mono"
          style={{ color: getSegmentColor(currentAvg) }}
        >
          {currentAvg.toFixed(1)}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="w-full"
        style={{ height: 200 }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Y-axis labels */}
        {yLabels.map((v) => (
          <text
            key={v}
            x={PAD_LEFT - 8}
            y={toY(v) + 4}
            textAnchor="end"
            fill="var(--ink-3)"
            fontSize={11}
          >
            {v}
          </text>
        ))}

        {/* Horizontal reference lines */}
        {/* Baseline at 7 */}
        <line
          x1={PAD_LEFT}
          y1={toY(7)}
          x2={SVG_WIDTH - PAD_RIGHT}
          y2={toY(7)}
          stroke="var(--line-1)"
          strokeWidth={0.5}
          strokeDasharray="4 4"
        />
        {/* Euphoric at 9 */}
        <line
          x1={PAD_LEFT}
          y1={toY(9)}
          x2={SVG_WIDTH - PAD_RIGHT}
          y2={toY(9)}
          stroke="rgba(52, 211, 153, 0.3)"
          strokeWidth={0.5}
          strokeDasharray="4 4"
        />

        {/* Area fill under curve (8% opacity per segment) */}
        {areaFillPaths.map((path, i) => {
          const color =
            i + 1 < areaPoints.length
              ? areaPoints[i + 1].color
              : areaPoints[areaPoints.length - 1].color;
          return (
            <path key={i} d={path} fill={color} opacity={0.08} />
          );
        })}

        {/* Multi-colored line segments */}
        {lineSegments.map((seg, i) => (
          <line
            key={i}
            x1={seg.x1}
            y1={seg.y1}
            x2={seg.x2}
            y2={seg.y2}
            stroke={seg.color}
            strokeWidth={2}
            strokeLinecap="round"
          />
        ))}

        {/* Running average overlay line */}
        <polyline
          points={avgPolyline}
          fill="none"
          stroke="var(--ink-2)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.4}
        />

        {/* Data point circles + hover hitboxes */}
        {reflections.map((r, i) => {
          const x = toX(r.timestamp);
          const y = toY(r.sentiment);
          const color = getSegmentColor(r.sentiment);

          return (
            <g key={i}>
              {/* Visible dot */}
              <circle cx={x} cy={y} r={4} fill={color} />

              {/* Invisible larger hitbox for hover */}
              <circle
                cx={x}
                cy={y}
                r={12}
                fill="transparent"
                className="cursor-default"
                onMouseEnter={(e) => {
                  const svg = (
                    e.currentTarget.ownerSVGElement as SVGSVGElement
                  ).getBoundingClientRect();
                  const ptX = svg.left + (x / SVG_WIDTH) * svg.width;
                  const ptY = svg.top + (y / SVG_HEIGHT) * svg.height;
                  setTooltip({
                    task: r.taskDescription,
                    sentiment: r.sentiment,
                    x: ptX,
                    y: ptY,
                  });
                }}
                onMouseLeave={() => setTooltip(null)}
              />
            </g>
          );
        })}

        {/* X-axis labels */}
        {xLabels.map((label, i) => (
          <text
            key={i}
            x={label.x}
            y={SVG_HEIGHT - 4}
            textAnchor="middle"
            fill="var(--ink-3)"
            fontSize={10}
          >
            {formatDate(label.timestamp)}
          </text>
        ))}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 px-2.5 py-1.5 rounded-md bg-surface-2 border border-white/[0.08] shadow-lg pointer-events-none max-w-[240px]"
          style={{
            left: tooltip.x,
            top: tooltip.y - 44,
            transform: "translateX(-50%)",
          }}
        >
          <p className="text-xs text-ink-1 font-medium truncate">
            {tooltip.task}
          </p>
          <p className="text-[13px] font-mono" style={{ color: getSegmentColor(tooltip.sentiment) }}>
            Sentiment: {tooltip.sentiment}/10
          </p>
        </div>
      )}
    </div>
  );
}
