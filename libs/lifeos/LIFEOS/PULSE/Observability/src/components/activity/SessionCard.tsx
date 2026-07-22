"use client";

import type { AlgorithmState, SessionMode } from "@/types/algorithm";
import { Progress } from "@/components/ui/progress";
import ModeBadge from "./ModeBadge";
import NativeSessionRow from "./NativeSessionRow";
import CompletedSessionRow from "./CompletedSessionRow";
import AlgorithmKanban from "./AlgorithmKanban";
import EffortBadge from "./EffortBadge";

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function resolveMode(session: AlgorithmState): SessionMode {
  if (session.currentMode) return session.currentMode;
  if (session.mode === "native") return "native";
  if (session.mode === "interactive" || session.mode === "starting") return "algorithm";
  // Infer from phase data: if it has criteria/phase history, it's algorithm
  if (session.criteria?.length > 0 || session.phaseHistory?.length > 0) return "algorithm";
  return "native";
}

const STALE_THRESHOLDS: Record<SessionMode, number> = {
  minimal: 5 * 60 * 1000,
  native: 15 * 60 * 1000,
  algorithm: 30 * 60 * 1000,
};

interface SessionCardProps {
  session: AlgorithmState;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

export default function SessionCard({ session }: SessionCardProps) {
  const mode = resolveMode(session);
  // COMPLETE/LEARN phase = finished work, even if active flag is stale
  const isCompleted = !!session.completedAt || session.currentPhase === "COMPLETE" || session.currentPhase === "LEARN";

  // MINIMAL sessions don't render as cards
  if (mode === "minimal") return null;

  // Completed sessions use the compact row
  if (isCompleted) {
    return <CompletedSessionRow session={session} />;
  }

  // NATIVE sessions use the compact row
  if (mode === "native") {
    return <NativeSessionRow session={session} />;
  }

  // ALGORITHM mode — full card with kanban
  return <AlgorithmSessionCard session={session} />;
}

// ---- Algorithm full card ----

function AlgorithmSessionCard({ session }: { session: AlgorithmState }) {
  const elapsed = session.algorithmStartedAt
    ? formatElapsed(Date.now() - session.algorithmStartedAt)
    : "";

  const mode = resolveMode(session);
  const isStale = session.algorithmStartedAt
    ? Date.now() - session.algorithmStartedAt > STALE_THRESHOLDS[mode]
    : false;

  const sessionName = session.taskDescription
    ? session.taskDescription.replace(/^\[Telegram\]\s*/, "")
    : session.sessionId?.slice(0, 8) || "Session";

  const completedCount = session.criteria?.filter((c) => c.status === "completed").length ?? 0;
  const totalCount = session.criteria?.length ?? 0;
  const progressPct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  return (
    <div
      className={`border-b transition-opacity ${
        isStale ? "border-white/[0.03] opacity-60" : "border-white/[0.06]"
      }`}
    >
      {/* Header row — static, no click */}
      <div className="w-full px-4 py-2 flex items-center gap-3 text-left">
        {/* Activity dot */}
        {isStale ? (
          <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
        ) : (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
        )}

        <ModeBadge mode="algorithm" size="prominent" />

        <span className="text-base font-medium text-ink-1 truncate flex-1 min-w-0 uppercase tracking-wide">
          {sessionName}
        </span>

        {/* Effort */}
        {session.effortLevel && (
          <EffortBadge effort={session.effortLevel} />
        )}

        {/* Criteria progress */}
        {totalCount > 0 && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-sm font-mono text-ink-2">
              {completedCount}<span className="text-ink-3">/{totalCount}</span>
            </span>
            <div className="w-10">
              <Progress value={progressPct} className="h-1 [&>div]:bg-purple-400" />
            </div>
          </div>
        )}

        {/* Elapsed */}
        <span className="text-xs text-ink-3 font-mono shrink-0 tabular-nums">
          {elapsed}
        </span>
      </div>

      {/* Kanban — always visible, fixed height */}
      <div className="border-t border-white/[0.04] py-1.5">
        <AlgorithmKanban state={session} />
      </div>
    </div>
  );
}
