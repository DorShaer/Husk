"use client";

import { useState } from "react";
import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import type { AlgorithmState, SessionMode } from "@/types/algorithm";

/**
 * Widget 14: LiveSessionHeartbeatGrid
 *
 * A grid of pulsing squares, one per active session.
 * Pulse speed reflects how recently the session was updated.
 * Border color encodes session mode.
 */

const MODE_COLORS: Record<SessionMode, { border: string; bg: string; hex: string }> = {
  minimal: { border: "border-amber-500", bg: "bg-amber-500/10", hex: "#f59e0b" },
  native: { border: "border-blue-500", bg: "bg-blue-500/10", hex: "#3b82f6" },
  algorithm: { border: "border-purple-500", bg: "bg-purple-500/10", hex: "#a855f7" },
};

function resolveMode(session: AlgorithmState): SessionMode {
  if (session.currentMode) return session.currentMode;
  if (session.mode === "native") return "native";
  if (session.mode === "interactive" || session.mode === "starting") return "algorithm";
  if (session.criteria?.length > 0 || session.phaseHistory?.length > 0) return "algorithm";
  return "native";
}

function getSessionLabel(session: AlgorithmState): string {
  const desc = session.taskDescription;
  if (desc) {
    const cleaned = desc.replace(/^\[Telegram\]\s*/, "");
    return cleaned.charAt(0).toUpperCase();
  }
  return session.sessionId?.charAt(0)?.toUpperCase() || "?";
}

function getSessionName(session: AlgorithmState): string {
  if (session.taskDescription) {
    return session.taskDescription.replace(/^\[Telegram\]\s*/, "");
  }
  return session.sessionId?.slice(0, 8) || "Unknown";
}

function getLastUpdatedTime(session: AlgorithmState): number {
  // Best signal for recency: phaseStartedAt, or algorithmStartedAt as fallback
  return session.phaseStartedAt || session.algorithmStartedAt || 0;
}

function formatTimeSince(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

type PulseState = "fast" | "slow" | "static";

function getPulseState(lastUpdated: number): PulseState {
  const elapsed = Date.now() - lastUpdated;
  if (elapsed < 30_000) return "fast";
  if (elapsed < 5 * 60_000) return "slow";
  return "static";
}

function HeartbeatSquare({ session }: { session: AlgorithmState }) {
  const [showTooltip, setShowTooltip] = useState(false);

  const mode = resolveMode(session);
  const colors = MODE_COLORS[mode];
  const label = getSessionLabel(session);
  const lastUpdated = getLastUpdatedTime(session);
  const pulse = getPulseState(lastUpdated);

  const pulseClass =
    pulse === "fast"
      ? "animate-pulse"
      : pulse === "slow"
        ? "animate-pulse-glow"
        : "";

  const opacityClass = pulse === "static" ? "opacity-40" : "";
  const bgClass = pulse !== "static" ? colors.bg : "bg-surface-2";

  return (
    <div className="relative">
      <div
        className={`
          w-10 h-10 rounded-lg border flex items-center justify-center
          cursor-default select-none transition-opacity
          ${colors.border} ${bgClass} ${pulseClass} ${opacityClass}
        `}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        <span className="text-[14px] font-medium text-ink-1">{label}</span>
      </div>

      {/* Tooltip */}
      {showTooltip && (
        <div
          className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 rounded-md bg-surface-2 border border-white/[0.08] shadow-lg whitespace-nowrap pointer-events-none"
        >
          <p className="text-xs text-ink-1 font-medium">{getSessionName(session)}</p>
          <p className="text-[13px] text-ink-3">
            {lastUpdated > 0 ? formatTimeSince(lastUpdated) : "No activity"}
          </p>
          <div
            className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[5px] border-t-zinc-800"
          />
        </div>
      )}
    </div>
  );
}

export default function LiveSessionHeartbeatGrid() {
  const { algorithmStates, isLoading } = useAlgorithmState();

  const activeSessions = algorithmStates.filter((s) => s.active);

  return (
    <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
      <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
        Live Sessions
      </h3>

      {isLoading ? (
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-lg bg-surface-2 animate-pulse" />
          <div className="w-10 h-10 rounded-lg bg-surface-2 animate-pulse" />
        </div>
      ) : activeSessions.length === 0 ? (
        <p className="text-xs text-ink-3">No active sessions</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {activeSessions.map((session) => (
            <HeartbeatSquare key={session.sessionId} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}
