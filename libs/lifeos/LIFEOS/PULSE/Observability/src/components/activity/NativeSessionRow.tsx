"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type { AlgorithmState } from "@/types/algorithm";
import ModeBadge from "./ModeBadge";
import ModeTimeline from "./ModeTimeline";
import OperationBadge from "./OperationBadge";

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

interface NativeSessionRowProps {
  session: AlgorithmState;
}

export default function NativeSessionRow({ session }: NativeSessionRowProps) {
  const [expanded, setExpanded] = useState(false);

  const elapsed = session.algorithmStartedAt
    ? formatElapsed(Date.now() - session.algorithmStartedAt)
    : "";

  // A native session is a one-shot quick task — it doesn't fail, it just runs
  // and ends. So once it's no longer active (the payload flips `active` to false
  // after the native staleness window with no recent tool activity), it's DONE,
  // not "stale". Done sessions get a green check, matching CompletedSessionRow in
  // the Iterate tab — never the old amber dot that read as a warning long after
  // the work had actually finished.
  const isDone = session.active === false;

  const taskText = session.rawTask || session.taskDescription || "";
  const sessionName = session.taskDescription
    ? session.taskDescription.replace(/^\[Telegram\]\s*/, "")
    : session.sessionId?.slice(0, 8) || "Session";

  return (
    <div
      className={`w-full max-w-full overflow-hidden border-b transition-opacity ${
        isDone ? "border-emerald-500/10 opacity-60" : "border-blue-500/10"
      }`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full max-w-full px-4 py-2.5 flex items-center gap-3 min-w-0 overflow-hidden hover:bg-blue-500/[0.03] transition-colors text-left"
      >
        {/* Activity indicator — done: green check, active: pulsing green dot */}
        {isDone ? (
          <span className="w-4 h-4 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
            <Check className="w-2.5 h-2.5 text-emerald-400" strokeWidth={3} />
          </span>
        ) : (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
        )}

        <ModeBadge mode="native" size="compact" />

        <span className="text-base font-medium text-ink-1 truncate flex-1 min-w-0 uppercase tracking-wide">
          {sessionName}
        </span>

        {taskText && taskText !== sessionName && (
          <span className="text-sm text-ink-3 truncate max-w-64">
            {taskText.length > 80 ? taskText.slice(0, 80) + "..." : taskText}
          </span>
        )}

        {/* Current action inline */}
        {session.currentAction && !expanded && (
          <span className="text-xs text-emerald-400/60 font-mono truncate max-w-48 shrink-0">
            {session.currentAction}
          </span>
        )}

        <span className="text-sm text-ink-3 font-mono shrink-0 tabular-nums">
          {elapsed}
        </span>

        {/* Operation tag — effort tier OR mode chip (NATIVE / LOOP / OPTIMIZE / IDEATE / FAST) */}
        <OperationBadge
          mode={session.mode || session.currentMode}
          effort={session.effortLevel || session.sla}
          size="compact"
        />

        {/* Criteria count */}
        {session.criteria && session.criteria.length > 0 && (
          <span className="text-xs font-mono text-ink-3 shrink-0">
            {session.criteria.filter(c => c.status === "completed").length}/{session.criteria.length}
          </span>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {session.modeHistory && session.modeHistory.length > 1 && (
            <div className="px-2">
              <ModeTimeline
                modeHistory={session.modeHistory}
                currentMode={session.currentMode || "native"}
                isActive={session.active}
              />
            </div>
          )}
          {taskText && (
            <p className="text-sm text-ink-2 leading-relaxed pl-2">
              {taskText}
            </p>
          )}
          {session.currentAction && (
            <div className="flex items-center gap-2 pl-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <span className="text-sm text-emerald-400/80 font-mono truncate">
                {session.currentAction}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
