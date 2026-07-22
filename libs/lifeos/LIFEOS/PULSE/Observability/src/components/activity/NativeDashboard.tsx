"use client";

import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import NativeSessionRow from "./NativeSessionRow";
import { Terminal } from "lucide-react";

export default function NativeDashboard() {
  const { algorithmStates, isLoading } = useAlgorithmState();

  const nativeSessions = algorithmStates.filter(
    (s) => s.currentMode === "native" || s.mode === "native"
  );

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse text-ink-3 text-sm">Loading...</div>
      </div>
    );
  }

  if (nativeSessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="bg-white/[0.03] p-6 rounded-2xl mb-4 inline-block">
            <Terminal size={40} className="text-ink-3" />
          </div>
          <p className="text-base font-medium text-ink-2 mb-1">No native sessions</p>
          <p className="text-sm text-ink-3">Quick tasks will appear here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {nativeSessions.map((session) => (
        <NativeSessionRow key={session.sessionId} session={session} />
      ))}
    </div>
  );
}
