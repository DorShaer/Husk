import { Check } from "lucide-react";
import type { AlgorithmState } from "@/types/algorithm";
import ModeBadge from "./ModeBadge";
import OperationBadge from "./OperationBadge";

function formatRelative(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

interface CompletedSessionRowProps {
  session: AlgorithmState;
}

export default function CompletedSessionRow({ session }: CompletedSessionRowProps) {
  const mode = session.currentMode || (session.mode === "native" ? "native" : "algorithm");

  const sessionName = session.taskDescription
    ? session.taskDescription.replace(/^\[Telegram\]\s*/, "")
    : session.sessionId?.slice(0, 8) || "Session";

  const completedCount = session.criteria?.filter((c) => c.status === "completed").length ?? 0;
  const totalCount = session.criteria?.length ?? 0;
  const completedAt = session.completedAt || session.algorithmStartedAt;

  const effortLevel = session.effortLevel || session.sla || "";

  return (
    <div className="w-full px-4 py-2 flex items-center gap-3 border-b border-white/[0.03] opacity-50 hover:opacity-70 transition-opacity text-left">
      <span className="w-4 h-4 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
        <Check className="w-2.5 h-2.5 text-emerald-400" strokeWidth={3} />
      </span>

      <ModeBadge mode={mode as "minimal" | "native" | "algorithm"} size="micro" />

      <span className="text-sm text-ink-2 truncate flex-1 min-w-0 uppercase tracking-wide">
        {sessionName}
      </span>

      {totalCount > 0 && (
        <span className="text-xs font-mono text-ink-3 shrink-0">
          {completedCount}/{totalCount}
        </span>
      )}

      <OperationBadge
        mode={session.mode || session.currentMode}
        effort={effortLevel}
        size="micro"
      />

      {(session.summary || session.rawTask) && (
        <span className="text-xs text-ink-3 truncate max-w-48">
          {session.summary || session.rawTask}
        </span>
      )}

      <span className="text-xs text-ink-3 font-mono shrink-0">
        {completedAt ? formatRelative(completedAt) : ""}
      </span>
    </div>
  );
}
