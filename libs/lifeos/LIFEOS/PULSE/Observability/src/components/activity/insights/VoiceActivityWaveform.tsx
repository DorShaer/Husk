"use client";

import { useState, useMemo, useRef } from "react";
import { useVoiceEvents } from "@/hooks/useObservabilityData";

// ─── Voice Activity Waveform (Widget 6) ───
// Vertical bars showing voice events over time, like an audio waveform.
// Each bar's height = normalized character_count, color = success/fail.

interface VoiceEvent {
  timestamp?: string;
  message?: string;
  character_count?: number;
  event_type?: string;
  error?: string;
}

type TimeRange = "1h" | "6h" | "24h";

const TIME_RANGE_MS: Record<TimeRange, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

interface TooltipData {
  message: string;
  timestamp: string;
  x: number;
  y: number;
}

function isSuccess(evt: VoiceEvent): boolean {
  if (evt.error) return false;
  if (
    evt.event_type === "success" ||
    evt.event_type === "sent" ||
    !evt.event_type
  )
    return true;
  return false;
}

function formatTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return isoStr;
  }
}

export default function VoiceActivityWaveform() {
  const { data, isLoading } = useVoiceEvents();
  const [range, setRange] = useState<TimeRange>("24h");
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const allEvents = (data?.events ?? []) as VoiceEvent[];
  const summary = data?.summary as
    | {
        total: number;
        successCount: number;
        failCount: number;
        successRate: number;
      }
    | undefined;

  const { filteredEvents, maxCharCount } = useMemo(() => {
    const now = Date.now();
    const cutoff = now - TIME_RANGE_MS[range];

    const filtered = allEvents.filter((evt) => {
      if (!evt.timestamp) return false;
      return new Date(evt.timestamp).getTime() > cutoff;
    });

    let maxCC = 0;
    for (const evt of filtered) {
      const cc = evt.character_count ?? 0;
      if (cc > maxCC) maxCC = cc;
    }

    return { filteredEvents: filtered, maxCharCount: maxCC || 1 };
  }, [allEvents, range]);

  // Layout constants
  const WAVEFORM_HEIGHT = 100;
  const BAR_WIDTH = 3;
  const BAR_GAP = 1;
  const MIN_BAR_HEIGHT = 20;
  const MAX_BAR_HEIGHT = 80;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        Loading voice events...
      </div>
    );
  }

  if (filteredEvents.length === 0 && allEvents.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        No voice events recorded
      </div>
    );
  }

  // Compute time range boundaries
  const now = Date.now();
  const rangeStart = now - TIME_RANGE_MS[range];
  const timeSpan = TIME_RANGE_MS[range];

  // Health badge color
  const healthRate = summary?.successRate ?? 0;
  const healthColor =
    healthRate >= 90
      ? "text-emerald-400 bg-emerald-500/10"
      : healthRate >= 70
        ? "text-amber-400 bg-amber-500/10"
        : "text-rose-400 bg-rose-500/10";

  return (
    <div className="space-y-3 relative" ref={containerRef}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        {/* Time range selector */}
        <div className="flex items-center gap-1 bg-[rgba(20,28,56,0.5)] rounded p-0.5">
          {(["1h", "6h", "24h"] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 rounded text-[13px] transition-colors ${
                range === r
                  ? "bg-surface-3 text-ink-1"
                  : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Voice Health badge */}
        <span
          className={`px-2 py-0.5 rounded text-[13px] font-mono font-medium ${healthColor}`}
        >
          Voice Health: {Math.round(healthRate)}%
        </span>
      </div>

      {/* Waveform */}
      {filteredEvents.length === 0 ? (
        <div className="flex items-center justify-center text-ink-3 text-xs" style={{ height: `${WAVEFORM_HEIGHT}px` }}>
          No events in selected range
        </div>
      ) : (
        <div
          className="w-full overflow-hidden relative"
          style={{ height: `${WAVEFORM_HEIGHT}px` }}
        >
          <svg
            width="100%"
            height={WAVEFORM_HEIGHT}
            viewBox={`0 0 1000 ${WAVEFORM_HEIGHT}`}
            preserveAspectRatio="none"
            className="w-full"
          >
            {/* Baseline */}
            <line
              x1={0}
              y1={WAVEFORM_HEIGHT - 1}
              x2={1000}
              y2={WAVEFORM_HEIGHT - 1}
              stroke="var(--line-1)"
              strokeWidth={0.5}
            />

            {filteredEvents.map((evt, i) => {
              const ts = evt.timestamp
                ? new Date(evt.timestamp).getTime()
                : now;
              const xFraction = (ts - rangeStart) / timeSpan;
              const x = Math.max(0, Math.min(1, xFraction)) * 1000;

              const cc = evt.character_count ?? 0;
              const normalizedHeight =
                MIN_BAR_HEIGHT +
                ((cc / maxCharCount) * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT));
              const barHeight = Math.min(MAX_BAR_HEIGHT, normalizedHeight);

              const success = isSuccess(evt);
              const barColor = success ? "#34d399" : "#f43f5e"; // emerald-500 / rose-500
              const y = WAVEFORM_HEIGHT - barHeight;

              return (
                <g key={i}>
                  <rect
                    x={x - BAR_WIDTH / 2}
                    y={y}
                    width={BAR_WIDTH}
                    height={barHeight}
                    fill={barColor}
                    rx={1}
                    opacity={0.85}
                    className="cursor-pointer"
                    onMouseEnter={(e) => {
                      const svgEl = (
                        e.target as SVGElement
                      ).closest("svg");
                      const containerEl = containerRef.current;
                      if (!svgEl || !containerEl) return;

                      const svgRect = svgEl.getBoundingClientRect();
                      const containerRect =
                        containerEl.getBoundingClientRect();
                      // Map SVG viewBox coordinates to screen
                      const screenX =
                        svgRect.left +
                        (x / 1000) * svgRect.width -
                        containerRect.left;
                      const screenY = svgRect.top + (y / WAVEFORM_HEIGHT) * svgRect.height - containerRect.top;

                      setTooltip({
                        message: (evt.message || "").slice(0, 80),
                        timestamp: evt.timestamp
                          ? formatTime(evt.timestamp)
                          : "unknown",
                        x: screenX,
                        y: screenY - 4,
                      });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
                  {/* Failed X icon */}
                  {!success && (
                    <g transform={`translate(${x}, ${y - 4})`}>
                      <line
                        x1={-2}
                        y1={-2}
                        x2={2}
                        y2={2}
                        stroke="#f43f5e"
                        strokeWidth={1.5}
                      />
                      <line
                        x1={2}
                        y1={-2}
                        x2={-2}
                        y2={2}
                        stroke="#f43f5e"
                        strokeWidth={1.5}
                      />
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="absolute z-50 pointer-events-none bg-surface-1 border border-line-2 rounded px-2 py-1.5 shadow-lg max-w-[250px]"
          style={{
            left: `${tooltip.x}px`,
            top: `${tooltip.y}px`,
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="text-[13px] text-ink-1 break-words">
            {tooltip.message || "(no message)"}
          </div>
          <div className="text-[13px] text-ink-3 mt-0.5">
            {tooltip.timestamp}
          </div>
        </div>
      )}
    </div>
  );
}
