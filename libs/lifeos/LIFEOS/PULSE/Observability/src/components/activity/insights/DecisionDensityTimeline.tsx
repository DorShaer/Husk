"use client";

import { useState, useMemo } from "react";
import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import type { AlgorithmState, AlgorithmCriterion, PhaseEntry } from "@/types/algorithm";

/**
 * Widget 7: DecisionDensityTimeline
 *
 * Stacked area chart showing criteria creation/completion/failure density over time.
 * Buckets criteria into 15-minute intervals. SVG-only, no external charting libraries.
 */

type TimeRange = "6h" | "24h" | "7d";

const TIME_RANGE_MS: Record<TimeRange, number> = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const BUCKET_MS = 15 * 60 * 1000; // 15 minutes

interface Bucket {
  time: number;
  created: number;
  completed: number;
  failed: number;
}

function getPhaseStartTime(
  criterion: AlgorithmCriterion,
  phaseHistory: PhaseEntry[]
): number | null {
  const matchingPhase = phaseHistory.find(
    (p) => p.phase === criterion.createdInPhase
  );
  return matchingPhase?.startedAt ?? null;
}

function extractCriteriaEvents(sessions: AlgorithmState[]): {
  created: number[];
  completed: number[];
  failed: number[];
} {
  const created: number[] = [];
  const completed: number[] = [];
  const failed: number[] = [];

  for (const session of sessions) {
    const phaseHistory = session.phaseHistory ?? [];
    const criteria = session.criteria ?? [];
    const sessionUpdatedAt =
      session.completedAt ?? session.phaseStartedAt ?? Date.now();

    for (const criterion of criteria) {
      // Created timestamp: infer from the startedAt of its createdInPhase
      const createdTime = getPhaseStartTime(criterion, phaseHistory);
      if (createdTime) {
        created.push(createdTime);
      }

      // Completed/failed timestamp: approximate with session updatedAt
      if (criterion.status === "completed") {
        completed.push(sessionUpdatedAt);
      } else if (criterion.status === "failed") {
        failed.push(sessionUpdatedAt);
      }
    }
  }

  return { created, completed, failed };
}

function buildBuckets(
  events: { created: number[]; completed: number[]; failed: number[] },
  rangeStart: number,
  rangeEnd: number
): Bucket[] {
  const bucketCount = Math.max(
    1,
    Math.ceil((rangeEnd - rangeStart) / BUCKET_MS)
  );
  const buckets: Bucket[] = [];

  for (let i = 0; i < bucketCount; i++) {
    buckets.push({
      time: rangeStart + i * BUCKET_MS,
      created: 0,
      completed: 0,
      failed: 0,
    });
  }

  const assign = (timestamps: number[], key: "created" | "completed" | "failed") => {
    for (const ts of timestamps) {
      if (ts < rangeStart || ts > rangeEnd) continue;
      const idx = Math.min(
        Math.floor((ts - rangeStart) / BUCKET_MS),
        bucketCount - 1
      );
      buckets[idx][key]++;
    }
  };

  assign(events.created, "created");
  assign(events.completed, "completed");
  assign(events.failed, "failed");

  return buckets;
}

function buildAreaPath(
  points: { x: number; y: number }[],
  baseline: number
): string {
  if (points.length === 0) return "";

  let d = `M ${points[0].x.toFixed(1)} ${baseline.toFixed(1)}`;
  d += ` L ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;

  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)}`;
  }

  d += ` L ${points[points.length - 1].x.toFixed(1)} ${baseline.toFixed(1)}`;
  d += " Z";

  return d;
}

function formatTimeLabel(timestamp: number, range: TimeRange): string {
  const date = new Date(timestamp);
  if (range === "7d") {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  const h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? "p" : "a";
  const hour12 = h % 12 || 12;
  return m === 0 ? `${hour12}${ampm}` : `${hour12}:${m.toString().padStart(2, "0")}${ampm}`;
}

export default function DecisionDensityTimeline() {
  const { algorithmStates, isLoading } = useAlgorithmState();
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");

  const now = Date.now();
  const rangeStart = now - TIME_RANGE_MS[timeRange];
  const rangeEnd = now;

  const { buckets, maxY, totals } = useMemo(() => {
    const events = extractCriteriaEvents(algorithmStates);
    const b = buildBuckets(events, rangeStart, rangeEnd);

    let max = 0;
    for (const bucket of b) {
      const total = bucket.created + bucket.completed + bucket.failed;
      if (total > max) max = total;
    }

    const totalCreated = b.reduce((s, bk) => s + bk.created, 0);
    const totalCompleted = b.reduce((s, bk) => s + bk.completed, 0);
    const totalFailed = b.reduce((s, bk) => s + bk.failed, 0);

    return {
      buckets: b,
      maxY: max || 1,
      totals: { created: totalCreated, completed: totalCompleted, failed: totalFailed },
    };
  }, [algorithmStates, rangeStart, rangeEnd]);

  // SVG dimensions
  const svgWidth = 600;
  const svgHeight = 160;
  const padLeft = 32;
  const padRight = 8;
  const padTop = 8;
  const padBottom = 20;
  const plotW = svgWidth - padLeft - padRight;
  const plotH = svgHeight - padTop - padBottom;
  const baseline = padTop + plotH;

  // Build stacked area layers (bottom-to-top: created, completed, failed)
  const createdPoints: { x: number; y: number }[] = [];
  const completedPoints: { x: number; y: number }[] = [];
  const failedPoints: { x: number; y: number }[] = [];

  for (let i = 0; i < buckets.length; i++) {
    const x = padLeft + (i / Math.max(buckets.length - 1, 1)) * plotW;
    const bk = buckets[i];

    const createdH = (bk.created / maxY) * plotH;
    const completedH = (bk.completed / maxY) * plotH;
    const failedH = (bk.failed / maxY) * plotH;

    // Bottom layer: created
    createdPoints.push({ x, y: baseline - createdH });
    // Middle layer: completed stacks on created
    completedPoints.push({ x, y: baseline - createdH - completedH });
    // Top layer: failed stacks on completed + created
    failedPoints.push({ x, y: baseline - createdH - completedH - failedH });
  }

  // Y-axis labels
  const yTicks = [0, Math.ceil(maxY / 2), maxY];

  // X-axis labels (show ~5 labels)
  const xLabelCount = Math.min(5, buckets.length);
  const xLabels: { x: number; label: string }[] = [];
  for (let i = 0; i < xLabelCount; i++) {
    const idx = Math.floor((i / Math.max(xLabelCount - 1, 1)) * (buckets.length - 1));
    const x = padLeft + (idx / Math.max(buckets.length - 1, 1)) * plotW;
    xLabels.push({ x, label: formatTimeLabel(buckets[idx].time, timeRange) });
  }

  const hasData = totals.created > 0 || totals.completed > 0 || totals.failed > 0;

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="h-[220px] flex items-center justify-center">
          <div className="w-full h-[160px] bg-[rgba(20,28,56,0.5)] rounded animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider">
          Decision Density
        </h3>
        <div className="flex gap-1">
          {(["6h", "24h", "7d"] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={`px-2 py-0.5 text-[13px] rounded transition-colors ${
                timeRange === r
                  ? "bg-surface-3 text-ink-1"
                  : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {!hasData ? (
        <div className="flex items-center justify-center h-[160px]">
          <p className="text-xs text-ink-3">No criteria data in selected time range</p>
        </div>
      ) : (
        <>
          <svg
            width="100%"
            height={svgHeight}
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            preserveAspectRatio="none"
            className="w-full"
          >
            {/* Y-axis gridlines */}
            {yTicks.map((tick) => {
              const y = baseline - (tick / maxY) * plotH;
              return (
                <g key={`y-${tick}`}>
                  <line
                    x1={padLeft}
                    y1={y}
                    x2={svgWidth - padRight}
                    y2={y}
                    stroke="var(--line-1)"
                    strokeWidth={0.5}
                    strokeDasharray="2 3"
                  />
                  <text
                    x={padLeft - 4}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="central"
                    fontSize={9}
                    fill="var(--ink-3)"
                  >
                    {tick}
                  </text>
                </g>
              );
            })}

            {/* Stacked area layers (bottom to top) */}

            {/* Layer 1 (bottom): Created - from baseline to created top */}
            {createdPoints.length > 0 && (
              <path
                d={buildAreaPath(createdPoints, baseline)}
                fill="rgba(96, 165, 250, 0.3)"
              />
            )}

            {/* Layer 2 (middle): Completed - between created top and completed top */}
            {completedPoints.length > 0 && (
              <path
                d={(() => {
                  let d = `M ${createdPoints[0].x.toFixed(1)} ${createdPoints[0].y.toFixed(1)}`;
                  for (let i = 0; i < completedPoints.length; i++) {
                    d += ` L ${completedPoints[i].x.toFixed(1)} ${completedPoints[i].y.toFixed(1)}`;
                  }
                  for (let i = createdPoints.length - 1; i >= 0; i--) {
                    d += ` L ${createdPoints[i].x.toFixed(1)} ${createdPoints[i].y.toFixed(1)}`;
                  }
                  d += " Z";
                  return d;
                })()}
                fill="rgba(52, 211, 153, 0.3)"
              />
            )}

            {/* Layer 3 (top): Failed - between completed top and failed top */}
            {failedPoints.length > 0 && (
              <path
                d={(() => {
                  let d = `M ${completedPoints[0].x.toFixed(1)} ${completedPoints[0].y.toFixed(1)}`;
                  for (let i = 0; i < failedPoints.length; i++) {
                    d += ` L ${failedPoints[i].x.toFixed(1)} ${failedPoints[i].y.toFixed(1)}`;
                  }
                  for (let i = completedPoints.length - 1; i >= 0; i--) {
                    d += ` L ${completedPoints[i].x.toFixed(1)} ${completedPoints[i].y.toFixed(1)}`;
                  }
                  d += " Z";
                  return d;
                })()}
                fill="rgba(251, 113, 133, 0.3)"
              />
            )}

            {/* X-axis labels */}
            {xLabels.map((lbl, i) => (
              <text
                key={`x-${i}`}
                x={lbl.x}
                y={svgHeight - 4}
                textAnchor="middle"
                fontSize={9}
                fill="var(--ink-3)"
              >
                {lbl.label}
              </text>
            ))}
          </svg>

          {/* Summary strip */}
          <div className="flex items-center gap-4 mt-2 text-[14px]">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-400" />
              <span className="text-ink-2">
                {totals.created} created
              </span>
              {totals.created > 0 && (
                <span className="text-blue-400">&#9650;</span>
              )}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-ink-2">
                {totals.completed} completed
              </span>
              {totals.completed > 0 && (
                <span className="text-emerald-400">&#9650;</span>
              )}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-rose-400" />
              <span className="text-ink-2">
                {totals.failed} failed
              </span>
              {totals.failed > 0 && (
                <span className="text-rose-400">&#9660;</span>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
