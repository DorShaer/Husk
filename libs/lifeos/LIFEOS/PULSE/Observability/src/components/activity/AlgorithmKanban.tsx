"use client";

import { Eye, Brain, ClipboardList, Hammer, Zap, CheckCircle2, BookOpen, AlertTriangle, type LucideIcon } from "lucide-react";
import type { AlgorithmPhase, AlgorithmState, AlgorithmCriterion } from "@/types/algorithm";

// ─── Phase Config ───

interface PhaseConfig {
  phase: AlgorithmPhase;
  label: string;
  icon: LucideIcon;
  color: string;
  narrative: string;
}

const PHASES: PhaseConfig[] = [
  {
    phase: "OBSERVE",
    label: "Observe",
    icon: Eye,
    color: "#7dcfff",
    narrative: "Reverse-engineering what success looks like. Scanning all capabilities. Building Ideal State Criteria\u2009\u2014\u2009the granular, binary conditions that define done.",
  },
  {
    phase: "THINK",
    label: "Think",
    icon: Brain,
    color: "#bb9af7",
    narrative: "Deep analysis of edge cases and complexity. Evolving ISC criteria with new insights. Deciding which additional capabilities to invoke.",
  },
  {
    phase: "PLAN",
    label: "Plan",
    icon: ClipboardList,
    color: "#7aa2f7",
    narrative: "Determining execution strategy. Evaluating parallelization opportunities. Partitioning criteria across agents or planning sequential execution.",
  },
  {
    phase: "BUILD",
    label: "Build",
    icon: Hammer,
    color: "#ff9e64",
    narrative: "Creating artifacts. Writing code, generating content, building infrastructure. Documenting non-obvious decisions as they emerge.",
  },
  {
    phase: "EXECUTE",
    label: "Execute",
    icon: Zap,
    color: "#9ece6a",
    narrative: "Running the work using selected capabilities. Deploying agents, executing skills. Discovering and adding edge case criteria.",
  },
  {
    phase: "VERIFY",
    label: "Verify",
    icon: CheckCircle2,
    color: "#73daca",
    narrative: "The culmination. Testing every ISC criterion with evidence. Each gets a binary YES/NO with proof. This is where hill-climbing happens.",
  },
  {
    phase: "LEARN",
    label: "Learn",
    icon: BookOpen,
    color: "#e0af68",
    narrative: "Capturing insights. What worked, what didn't, what to improve next iteration. Updating the ISA with final state and context.",
  },
];

const PHASE_ORDER = PHASES.map((p) => p.phase);

// ─── Criterion Card ───

function CriterionCard({ criterion }: { criterion: AlgorithmCriterion }) {
  const isAnti = criterion.type === "anti-criterion";
  const statusColors: Record<string, string> = {
    pending: "bg-ink-3",
    in_progress: "bg-blue-500 animate-pulse",
    completed: "bg-emerald-500",
    failed: "bg-red-500",
  };

  return (
    <div
      className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-1 group relative"
      title={criterion.evidence ?? criterion.description}
    >
      <div className="flex items-center gap-1">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColors[criterion.status]}`} />
        <span
          className={`text-xs font-semibold leading-none ${
            isAnti ? "text-red-400" : "text-blue-400"
          }`}
        >
          {criterion.id}
        </span>
        {criterion.status === "completed" && (
          <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500 ml-auto" />
        )}
      </div>
      <p className="text-xs text-ink-2 leading-tight mt-0.5 line-clamp-2">{criterion.description}</p>
    </div>
  );
}

// ─── Phase Column ───

function PhaseColumn({
  config,
  currentPhase,
  criteria,
  idle,
  taskContext,
  fallbackText,
  warning,
}: {
  config: PhaseConfig;
  currentPhase: AlgorithmPhase;
  criteria: AlgorithmCriterion[];
  idle?: boolean;
  taskContext?: string;
  /** Text to render in the current phase column when there are no criteria.
   *  Priority order resolved by the board: ISA intent → task → phase narrative. */
  fallbackText?: string;
  /** Parser warning from work.json — when set, renders a small badge explaining
   *  why the column is empty (missing ISC section, etc). */
  warning?: 'missing-section' | 'empty-section' | 'all-dropped';
}) {
  const Icon = config.icon;
  const currentIdx = PHASE_ORDER.indexOf(currentPhase);
  const thisIdx = PHASE_ORDER.indexOf(config.phase);

  const isCurrent = config.phase === currentPhase;
  const isPast = thisIdx < currentIdx;
  // `isFuture` = thisIdx > currentIdx — derived implicitly via the ternary below
  // (the "else" branch of `isCurrent`/`isPast` is future).

  return (
    <div
      className={`flex flex-col min-w-0 flex-1 basis-0 overflow-hidden rounded transition-all ${
        idle
          ? "opacity-40"
          : isCurrent
          ? "border"
          : isPast
          ? "opacity-50"
          : "opacity-20"
      }`}
      style={
        isCurrent && !idle
          ? {
              borderColor: `${config.color}50`,
              backgroundColor: `${config.color}08`,
              boxShadow: `0 0 12px ${config.color}12`,
            }
          : undefined
      }
    >
      {/* Column header — compact */}
      <div className={`flex items-center gap-1.5 px-2 py-1.5 min-w-0 ${isCurrent && !idle ? "border-b border-white/[0.06]" : ""}`}>
        <Icon
          className="w-3.5 h-3.5 shrink-0"
          style={{ color: idle ? undefined : config.color }}
        />
        <span
          className="text-xs font-semibold truncate min-w-0"
          style={{ color: idle ? undefined : isCurrent ? config.color : undefined }}
        >
          {config.label}
        </span>
        {isPast && !idle && (
          <CheckCircle2 className="w-2.5 h-2.5 text-ink-3 ml-auto" />
        )}
        {isCurrent && !idle && criteria.length > 0 && (
          <span className="text-xs font-medium text-ink-2 ml-auto bg-white/[0.06] px-1 py-0.5 rounded">
            {criteria.length}
          </span>
        )}
      </div>

      {/* Cards — only render if there are criteria */}
      {criteria.length > 0 && (
        <div className="flex flex-col gap-1 p-1.5 overflow-y-auto flex-1 min-h-0">
          {criteria.map((c) => (
            <CriterionCard key={c.id} criterion={c} />
          ))}
        </div>
      )}

      {/* Task context for Observe column when no criteria */}
      {config.phase === "OBSERVE" && criteria.length === 0 && taskContext && !idle && (
        <div className="px-1.5 py-1.5 flex-1">
          <p className="text-xs text-ink-3 leading-tight italic line-clamp-4">
            {taskContext}
          </p>
        </div>
      )}

      {/* Current-phase empty state — meaningful content beats "In progress..." */}
      {isCurrent && !idle && criteria.length === 0 && config.phase !== "OBSERVE" && (
        <div className="px-1.5 py-1.5 flex-1 flex flex-col gap-1">
          {fallbackText && (
            <p className="text-xs text-ink-2 leading-tight line-clamp-4">
              {fallbackText}
            </p>
          )}
          {warning && (
            <div
              className="flex items-start gap-1 rounded border border-amber-500/20 bg-amber-500/5 px-1.5 py-1"
              title={
                warning === 'missing-section'
                  ? "This ISA has no ISC Criteria section. Add one so criteria show here."
                  : warning === 'empty-section'
                  ? "The ISC Criteria section is empty. Add `- [ ] ISC-1 [F]: ...` entries."
                  : "Criteria lines present but none could be parsed. Check the line format."
              }
            >
              <AlertTriangle className="w-2.5 h-2.5 text-amber-400 shrink-0 mt-[1px]" />
              <span className="text-[10px] text-amber-300 leading-tight">
                {warning === 'missing-section'
                  ? 'no ISC section'
                  : warning === 'empty-section'
                  ? 'ISC section empty'
                  : 'ISC parse failed'}
              </span>
            </div>
          )}
          {!fallbackText && !warning && (
            <p className="text-xs text-ink-3 leading-tight italic">
              {config.narrative.split('.')[0] + '.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Kanban Board ───

export default function AlgorithmKanban({
  state,
  idle,
}: {
  state?: AlgorithmState | null;
  idle?: boolean;
}) {
  // Unified fallback text for every empty column — intent first (richest),
  // then the raw task or derived description. Never a generic "In progress...".
  const fallbackText = (state?.intent && state.intent.length > 0)
    ? state.intent
    : (state?.rawTask && state.rawTask.length > 0)
      ? state.rawTask
      : (state?.taskDescription && state.taskDescription.length > 0
          ? state.taskDescription
          : "");

  return (
    <div className="flex gap-1.5 px-3 max-h-[160px] w-full min-w-0 overflow-hidden">
      {PHASES.map((config) => {
        let criteria: AlgorithmCriterion[] = [];

        if (state && !idle) {
          if (config.phase === "VERIFY") {
            // When phase is COMPLETE or LEARN, all criteria belong in VERIFY
            if (state.currentPhase === "COMPLETE" || state.currentPhase === "LEARN") {
              criteria = state.criteria;
            } else {
              const verified = state.criteria.filter(
                (c) => c.status === "completed" || c.status === "failed"
              );
              // Fallback: if phase is VERIFY but no criteria are checked off
              // (executor bumped progress without marking checkboxes), show all
              if (state.currentPhase === "VERIFY" && verified.length === 0 && state.criteria.length > 0) {
                criteria = state.criteria;
              } else {
                criteria = verified;
              }
            }
          } else if (config.phase === state.currentPhase) {
            criteria = state.criteria.filter(
              (c) => c.status === "pending" || c.status === "in_progress"
            );
          }
        }

        return (
          <PhaseColumn
            key={config.phase}
            config={config}
            currentPhase={state?.currentPhase ?? "IDLE"}
            criteria={criteria}
            idle={idle}
            taskContext={config.phase === "OBSERVE" ? fallbackText : undefined}
            fallbackText={fallbackText}
            warning={state?.criteriaParseWarning}
          />
        );
      })}
    </div>
  );
}
