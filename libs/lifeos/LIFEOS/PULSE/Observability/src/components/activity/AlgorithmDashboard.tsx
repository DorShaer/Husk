"use client";

import { useState } from "react";
import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import AlgorithmKanban from "./AlgorithmKanban";
import PhaseDetailPanel from "./PhaseDetailPanel";
import type { AlgorithmState } from "@/types/algorithm";
import { Loader2, Eye, Brain, ClipboardList, Hammer, Zap, CheckCircle2, BookOpen, ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";

// ─── Phase Config ───

const PHASE_ICONS: Record<string, { icon: LucideIcon; color: string }> = {
  OBSERVE: { icon: Eye, color: "#7dcfff" },
  THINK: { icon: Brain, color: "#bb9af7" },
  PLAN: { icon: ClipboardList, color: "#7aa2f7" },
  BUILD: { icon: Hammer, color: "#ff9e64" },
  EXECUTE: { icon: Zap, color: "#9ece6a" },
  VERIFY: { icon: CheckCircle2, color: "#73daca" },
  LEARN: { icon: BookOpen, color: "#e0af68" },
  COMPLETE: { icon: CheckCircle2, color: "#73daca" },
  IDLE: { icon: Eye, color: "#565f89" },
};

const ALGORITHM_PHASES: { icon: LucideIcon; name: string; color: string; description: string }[] = [
  {
    icon: Eye,
    name: "Observe",
    color: "#7dcfff",
    description: "Reverse-engineer the request into Ideal State Criteria \u2014 granular, binary, testable conditions that define success and failure.",
  },
  {
    icon: Brain,
    name: "Think",
    color: "#bb9af7",
    description: "Analyze edge cases, dependencies, and complexity. Evolve criteria. Decide which capabilities to invoke from the full LifeOS toolkit.",
  },
  {
    icon: ClipboardList,
    name: "Plan",
    color: "#7aa2f7",
    description: "Choose execution strategy. Evaluate parallelization. Partition independent criteria across agents or plan sequential execution.",
  },
  {
    icon: Hammer,
    name: "Build",
    color: "#ff9e64",
    description: "Create artifacts: code, content, infrastructure. Document non-obvious decisions. Discover new requirements as they emerge.",
  },
  {
    icon: Zap,
    name: "Execute",
    color: "#9ece6a",
    description: "Deploy capabilities. Run skills, spawn agents, execute the plan. Edge cases discovered here become new criteria.",
  },
  {
    icon: CheckCircle2,
    name: "Verify",
    color: "#73daca",
    description: "The culmination. Every ISC criterion tested against evidence. Binary YES/NO with proof. This is where hill-climbing happens.",
  },
  {
    icon: BookOpen,
    name: "Learn",
    color: "#e0af68",
    description: "Capture insights. What worked, what didn't, what to improve. Update the ISA with final state and session context for next iteration.",
  },
];

// ─── Idle State Educational Content ───

function IdleContent() {
  return (
    <div className="flex flex-col flex-1 overflow-y-auto">
      <div className="px-6 py-5 border-b border-white/[0.04]">
        <h2 className="text-base font-semibold text-ink-1 mb-1">The LifeOS Algorithm</h2>
        <p className="text-[16px] text-ink-3 leading-relaxed max-w-2xl">
          A 7-phase scientific loop that hill-climbs from current state to ideal state.
          Every task is decomposed into Ideal State Criteria (ISC) {"\u2014"} granular, binary, testable conditions
          that become the verification criteria. No ambiguity. No hand-waving. Just evidence.
        </p>
      </div>
      <div className="flex-1 px-6 py-4">
        <div className="grid grid-cols-7 gap-3 h-full">
          {ALGORITHM_PHASES.map((phase) => {
            const Icon = phase.icon;
            return (
              <div
                key={phase.name}
                className="flex flex-col rounded-lg border border-white/[0.04] bg-white/[0.01] p-3 opacity-50"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="w-4 h-4" style={{ color: phase.color }} />
                  <span className="text-[16px] font-medium" style={{ color: phase.color }}>
                    {phase.name}
                  </span>
                </div>
                <p className="text-[14px] text-ink-3 leading-relaxed flex-1">
                  {phase.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
      <div className="px-6 py-3 border-t border-white/[0.04] text-center">
        <p className="text-[14px] text-ink-3">
          Waiting for an algorithm run. When active, ISC criteria flow through the Kanban as live cards.
        </p>
      </div>
    </div>
  );
}

// ─── Compact Algorithm Row (for non-expanded items) ───

function AlgorithmRow({
  state,
  isExpanded,
  onToggle,
}: {
  state: AlgorithmState;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isComplete = state.currentPhase === "COMPLETE";
  const phaseInfo = PHASE_ICONS[state.currentPhase] || PHASE_ICONS.IDLE;
  const PhaseIcon = phaseInfo.icon;
  const completedCount = state.criteria.filter((c) => c.status === "completed").length;
  const totalCount = state.criteria.length;
  const elapsed = state.phaseStartedAt ? Math.floor((Date.now() - state.algorithmStartedAt) / 1000) : 0;
  const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;

  return (
    <button
      onClick={onToggle}
      className="w-full px-4 py-3 flex items-center gap-3 border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors text-left"
    >
      {isExpanded ? (
        <ChevronDown className="w-3.5 h-3.5 text-ink-3 shrink-0" />
      ) : (
        <ChevronRight className="w-3.5 h-3.5 text-ink-3 shrink-0" />
      )}

      {isComplete ? (
        <div className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
      ) : (
        <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
      )}

      <PhaseIcon className="w-3.5 h-3.5 shrink-0" style={{ color: phaseInfo.color }} />

      <span className="text-[16px] font-medium text-ink-1 truncate flex-1">
        {state.taskDescription || "Algorithm run"}
      </span>

      <span className="text-[14px] font-mono shrink-0" style={{ color: phaseInfo.color }}>
        {state.currentPhase}
      </span>

      <span className="text-[14px] text-ink-3 shrink-0 tabular-nums">
        {completedCount}/{totalCount} ISC
      </span>

      <span className="text-[14px] text-ink-3 shrink-0 tabular-nums w-14 text-right">
        {elapsedStr}
      </span>
    </button>
  );
}

// ─── Single Algorithm Expanded View ───

function AlgorithmExpanded({ state }: { state: AlgorithmState }) {
  return (
    <div className="flex flex-col overflow-hidden border-b border-white/[0.06]">
      <div className="flex-1 overflow-y-auto py-3" style={{ maxHeight: "50vh" }}>
        <AlgorithmKanban state={state} />
      </div>
      <PhaseDetailPanel state={state} />
    </div>
  );
}

// ─── Main Dashboard ───

export default function AlgorithmDashboard() {
  const { algorithmStates, isLoading, error } = useAlgorithmState();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-ink-3">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        <span className="text-sm">Loading algorithm state...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 text-sm">
        {error}
      </div>
    );
  }

  if (algorithmStates.length === 0) {
    return <IdleContent />;
  }

  // Single algorithm — show full Kanban directly (original layout)
  if (algorithmStates.length === 1) {
    const state = algorithmStates[0];
    const isComplete = state.currentPhase === "COMPLETE";

    return (
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.04]">
          <div className="flex items-center gap-3">
            {isComplete ? (
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            ) : (
              <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
            )}
            <span className="text-[16px] font-medium text-ink-1">{state.taskDescription}</span>
            {state.prdPath && (
              <span className="text-[14px] text-ink-3 font-mono ml-auto">{state.prdPath}</span>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-3">
          <AlgorithmKanban state={state} />
        </div>
        <PhaseDetailPanel state={state} />
      </div>
    );
  }

  // Multiple algorithms — list with expandable rows
  // Auto-expand the first one if none selected
  const effectiveExpandedId = expandedId ?? algorithmStates[0]?.sessionId;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-white/[0.04] flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
        <span className="text-[16px] font-medium text-ink-1">
          {algorithmStates.length} Active Algorithm{algorithmStates.length > 1 ? "s" : ""}
        </span>
      </div>

      {/* Algorithm list */}
      <div className="flex-1 overflow-y-auto">
        {algorithmStates.map((state) => {
          const isExpanded = state.sessionId === effectiveExpandedId;
          return (
            <div key={state.sessionId}>
              <AlgorithmRow
                state={state}
                isExpanded={isExpanded}
                onToggle={() =>
                  setExpandedId(isExpanded ? null : state.sessionId)
                }
              />
              {isExpanded && <AlgorithmExpanded state={state} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
