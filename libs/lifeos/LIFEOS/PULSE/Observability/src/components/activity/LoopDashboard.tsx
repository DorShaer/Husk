"use client";

import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import SessionCard from "./SessionCard";
import PresetBadge from "./PresetBadge";
import { RefreshCw } from "lucide-react";

export default function LoopDashboard() {
  const { algorithmStates, isLoading } = useAlgorithmState();

  const loopSessions = algorithmStates.filter(
    (s) => s.mode === "loop"
  );

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse text-ink-3 text-sm">Loading...</div>
      </div>
    );
  }

  if (loopSessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="bg-white/[0.03] p-6 rounded-2xl mb-4 inline-block">
            <RefreshCw size={40} className="text-ink-3" />
          </div>
          <p className="text-base font-medium text-ink-2 mb-1">No loop sessions</p>
          <p className="text-sm text-ink-3">Iterative loop runs will appear here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto space-y-2 p-4">
      {loopSessions.map((session) => (
        <div key={session.sessionId}>
          {session.algorithmConfig && (
            <div className="px-4 pt-2 pb-1 flex items-center gap-2">
              <PresetBadge preset={session.algorithmConfig.preset} mode={session.algorithmConfig.mode} />
            </div>
          )}
          <SessionCard session={session} />
        </div>
      ))}
    </div>
  );
}
