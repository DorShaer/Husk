"use client";

import { useState, useMemo } from "react";
import { useToolFailures } from "@/hooks/useObservabilityData";

// ─── Error Heatmap Calendar (Widget 2) ───
// GitHub-contribution-style heatmap showing tool failure density by day/hour.
// 7 rows (Mon-Sun) x 24 columns (0-23h) grid of colored cells.

interface ToolFailureEvent {
  timestamp?: string;
  tool_name?: string;
}

// JS Date.getDay(): 0=Sun, 1=Mon, ..., 6=Sat
// Display order: Mon=0, Tue=1, ..., Sun=6
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Map JS getDay() (0=Sun) to display row (Mon=0 ... Sun=6)
const JS_DOW_TO_ROW: Record<number, number> = {
  1: 0, // Mon
  2: 1, // Tue
  3: 2, // Wed
  4: 3, // Thu
  5: 4, // Fri
  6: 5, // Sat
  0: 6, // Sun
};

const HOUR_LABELS = [0, 3, 6, 9, 12, 15, 18, 21];
const CELL_SIZE = 14;
const CELL_GAP = 2;

function getCellColor(count: number): string {
  if (count === 0) return "bg-surface-2";
  if (count <= 2) return "bg-amber-900/50";
  if (count <= 4) return "bg-amber-600/60";
  return "bg-rose-500/70";
}

interface TooltipData {
  day: string;
  hour: number;
  count: number;
  tools: Array<{ name: string; count: number }>;
  x: number;
  y: number;
}

export default function ErrorHeatmapCalendar() {
  const { data, isLoading } = useToolFailures();
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  const events = (data?.events ?? []) as ToolFailureEvent[];

  // Build heatmap from API heatmap data (numeric dayOfWeek keys)
  const { grid, weekTotal, toolsByCell } = useMemo(() => {
    const heatmap =
      (data as { heatmap?: Record<string, Record<string, number>> } | null)
        ?.heatmap ?? {};
    const g: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    const cellTools: Record<string, Record<string, number>> = {};

    // Populate grid from heatmap (keyed by JS getDay number)
    for (const [dowStr, hours] of Object.entries(heatmap)) {
      const jsDow = parseInt(dowStr, 10);
      const row = JS_DOW_TO_ROW[jsDow];
      if (row === undefined) continue;
      for (const [hourStr, count] of Object.entries(hours)) {
        const hour = parseInt(hourStr, 10);
        if (hour >= 0 && hour < 24) {
          g[row][hour] = count as number;
        }
      }
    }

    // Build per-cell tool breakdown from events
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    let total = 0;

    for (const evt of events) {
      if (!evt.timestamp) continue;
      const d = new Date(evt.timestamp);
      const ts = d.getTime();
      if (ts > oneWeekAgo) total++;

      const row = JS_DOW_TO_ROW[d.getDay()];
      if (row === undefined) continue;
      const hour = d.getHours();
      const cellKey = `${row}-${hour}`;
      if (!cellTools[cellKey]) cellTools[cellKey] = {};
      const toolName = evt.tool_name || "unknown";
      cellTools[cellKey][toolName] = (cellTools[cellKey][toolName] || 0) + 1;
    }

    return { grid: g, weekTotal: total, toolsByCell: cellTools };
  }, [data, events]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        Loading error heatmap...
      </div>
    );
  }

  return (
    <div className="space-y-3 relative">
      {/* Summary */}
      <div className="text-[13px] text-ink-3">
        {weekTotal} failures this week
      </div>

      <div className="flex gap-3">
        {/* Grid area */}
        <div className="flex gap-1">
          {/* Row labels */}
          <div
            className="flex flex-col shrink-0"
            style={{ paddingTop: `${CELL_SIZE + CELL_GAP}px` }}
          >
            {DOW_LABELS.map((label) => (
              <div
                key={label}
                className="text-[13px] text-ink-3 pr-1 flex items-center"
                style={{ height: `${CELL_SIZE + CELL_GAP}px` }}
              >
                {label}
              </div>
            ))}
          </div>

          {/* Grid */}
          <div>
            {/* Column labels */}
            <div className="flex" style={{ height: `${CELL_SIZE}px` }}>
              {Array.from({ length: 24 }, (_, h) => (
                <div
                  key={h}
                  className="flex items-end justify-center"
                  style={{ width: `${CELL_SIZE + CELL_GAP}px` }}
                >
                  {HOUR_LABELS.includes(h) && (
                    <span className="text-[13px] text-ink-3">{h}</span>
                  )}
                </div>
              ))}
            </div>

            {/* Cells */}
            <div
              className="flex flex-col"
              style={{ gap: `${CELL_GAP}px`, marginTop: `${CELL_GAP}px` }}
            >
              {grid.map((row, rowIdx) => (
                <div key={rowIdx} className="flex" style={{ gap: `${CELL_GAP}px` }}>
                  {row.map((count, hourIdx) => (
                    <div
                      key={hourIdx}
                      className={`rounded-sm cursor-pointer transition-opacity hover:opacity-80 ${getCellColor(count)}`}
                      style={{
                        width: `${CELL_SIZE}px`,
                        height: `${CELL_SIZE}px`,
                      }}
                      onMouseEnter={(e) => {
                        const cellKey = `${rowIdx}-${hourIdx}`;
                        const tools = Object.entries(
                          toolsByCell[cellKey] || {}
                        )
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 3)
                          .map(([name, c]) => ({ name, count: c }));

                        const rect = (
                          e.target as HTMLElement
                        ).getBoundingClientRect();
                        const parentRect = (
                          e.target as HTMLElement
                        ).closest(".relative")?.getBoundingClientRect();
                        const offsetX = parentRect
                          ? rect.left - parentRect.left
                          : rect.left;
                        const offsetY = parentRect
                          ? rect.top - parentRect.top
                          : rect.top;

                        setTooltip({
                          day: DOW_LABELS[rowIdx],
                          hour: hourIdx,
                          count,
                          tools,
                          x: offsetX + CELL_SIZE / 2,
                          y: offsetY - 4,
                        });
                      }}
                      onMouseLeave={() => setTooltip(null)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Color legend */}
        <div className="flex flex-col gap-1 items-center justify-center ml-2 shrink-0">
          <span className="text-[13px] text-ink-3 mb-1">Less</span>
          {[0, 1, 3, 5].map((threshold) => (
            <div
              key={threshold}
              className={`rounded-sm ${getCellColor(threshold)}`}
              style={{ width: `${CELL_SIZE - 2}px`, height: `${CELL_SIZE - 2}px` }}
            />
          ))}
          <span className="text-[13px] text-ink-3 mt-1">More</span>
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="absolute z-50 pointer-events-none bg-surface-1 border border-line-2 rounded px-2 py-1.5 shadow-lg"
          style={{
            left: `${tooltip.x}px`,
            top: `${tooltip.y}px`,
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="text-[13px] text-ink-1 font-medium whitespace-nowrap">
            {tooltip.day} {tooltip.hour > 12 ? tooltip.hour - 12 : tooltip.hour === 0 ? 12 : tooltip.hour}
            {tooltip.hour >= 12 ? "PM" : "AM"}: {tooltip.count} failure
            {tooltip.count !== 1 ? "s" : ""}
          </div>
          {tooltip.tools.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {tooltip.tools.map((t) => (
                <div
                  key={t.name}
                  className="text-[13px] text-ink-3 font-mono whitespace-nowrap"
                >
                  {t.name}: {t.count}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
