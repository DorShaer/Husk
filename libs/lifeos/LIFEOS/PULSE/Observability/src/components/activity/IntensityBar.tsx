"use client";

import type { TimeRange } from "@/hooks/useChartData";

interface IntensityBarProps {
  intensity: number;
  color: string;
  label: string;
  eventsPerMinute: number;
  timeRange: TimeRange;
  timeRanges: TimeRange[];
  onSetTimeRange: (range: TimeRange) => void;
}

function getContrastColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "var(--ground)" : "#ffffff";
}

export default function IntensityBar({
  intensity,
  color,
  label,
  eventsPerMinute,
  timeRange,
  timeRanges,
  onSetTimeRange,
}: IntensityBarProps) {
  return (
    <div className="flex items-center gap-3 px-4">
      {/* Events per minute */}
      <div className="flex items-center gap-1 shrink-0 transition-colors duration-[2s]" style={{ color }}>
        <span className="text-base font-semibold tabular-nums">{eventsPerMinute}</span>
        <span className="text-[14px] font-semibold opacity-70 uppercase">ev/min</span>
      </div>

      {/* Intensity bar */}
      <div className="relative flex-1 h-1 bg-[var(--ground)] overflow-hidden rounded-sm">
        <div
          className="absolute top-0 left-0 h-full rounded-sm transition-all duration-500 ease-out"
          style={{
            backgroundColor: color,
            width: `${Math.max(5, intensity * 100)}%`,
            transition: "background-color 2s ease-in-out, width 0.5s ease-out",
          }}
          title={`Activity: ${label} (${Math.round(intensity * 100)}%)`}
        >
          <div
            className="absolute inset-0"
            style={{
              background: "linear-gradient(to right, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%)",
              animation: "shimmer 3s ease-in-out infinite",
            }}
          />
        </div>
      </div>

      {/* Time range selector */}
      {timeRanges.length > 0 && (
        <div className="flex items-center gap-1 shrink-0">
          {timeRanges.map((range) => (
            <button
              key={range}
              onClick={() => onSetTimeRange(range)}
              className={`px-3 py-1 text-sm font-bold rounded cursor-pointer transition-all ${
                timeRange === range ? "shadow-md" : "bg-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)] hover:bg-[var(--ground)]"
              }`}
              style={
                timeRange === range
                  ? { backgroundColor: color, color: getContrastColor(color) }
                  : undefined
              }
            >
              {range}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
