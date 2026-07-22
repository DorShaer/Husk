"use client";

import type { ModeTransition, SessionMode } from "@/types/algorithm";

const MODE_COLORS: Record<SessionMode, string> = {
  minimal: "#e0af68",
  native: "#7aa2f7",
  algorithm: "#bb9af7",
};

const MODE_THICKNESS: Record<SessionMode, number> = {
  minimal: 1,
  native: 2,
  algorithm: 3,
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

interface ModeTimelineProps {
  modeHistory: ModeTransition[];
  currentMode: SessionMode;
  isActive: boolean;
}

export default function ModeTimeline({ modeHistory, currentMode, isActive }: ModeTimelineProps) {
  if (!modeHistory || modeHistory.length <= 1) return null;

  const now = Date.now();
  const segments = modeHistory.map((t) => {
    const end = t.endedAt ?? now;
    const duration = Math.max(end - t.startedAt, 1000);
    return { ...t, duration };
  });

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);

  return (
    <div className="flex items-center w-full gap-0" role="img" aria-label="Mode transition timeline">
      {segments.map((seg, i) => {
        const color = MODE_COLORS[seg.mode];
        const thickness = MODE_THICKNESS[seg.mode];
        const widthPct = Math.max((seg.duration / totalDuration) * 100, 5);
        const isCurrent = i === segments.length - 1 && !seg.endedAt;
        const label = `${seg.mode.charAt(0).toUpperCase() + seg.mode.slice(1)} for ${formatDuration(seg.duration)}`;

        return (
          <div key={i} className="flex items-center" style={{ width: `${widthPct}%`, minWidth: 32 }}>
            {/* Transition dot */}
            {i > 0 && (
              <div
                className="w-1.5 h-1.5 rounded-full shrink-0 -ml-0.5"
                style={{ backgroundColor: color }}
              />
            )}
            {/* Segment bar */}
            <div
              className="flex-1 rounded-full"
              style={{
                height: thickness,
                backgroundColor: color,
                opacity: isCurrent && isActive ? undefined : 0.7,
                animation: isCurrent && isActive ? "pulse-opacity 2s ease-in-out infinite" : undefined,
              }}
              title={label}
              aria-label={label}
            />
          </div>
        );
      })}
      <style jsx>{`
        @keyframes pulse-opacity {
          0%, 100% { opacity: 0.8; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
