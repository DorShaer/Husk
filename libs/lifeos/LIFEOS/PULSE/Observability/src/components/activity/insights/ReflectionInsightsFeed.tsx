"use client";

import { useState, useMemo } from "react";
import { useReflections } from "@/hooks/useObservabilityData";
import { RotateCcw, Brain, Sparkles, ChevronDown } from "lucide-react";

// ─── Widget 17: Reflection Insights Feed ───
// Vertical feed of AI self-reflection cards from algorithm-reflections.jsonl.
// Each card shows task, sentiment, effort, criteria, and 3 expandable reflection sections.

interface Reflection {
  timestamp: string;
  effort_level: string;
  task_description: string;
  criteria_count: number;
  criteria_passed: number;
  criteria_failed: number;
  implied_sentiment: number;
  reflection_q1: string;
  reflection_q2: string;
  reflection_q3: string;
}

function parseReflection(r: Record<string, unknown>): Reflection | null {
  if (
    typeof r.timestamp !== "string" ||
    typeof r.implied_sentiment !== "number" ||
    typeof r.task_description !== "string"
  ) {
    return null;
  }
  return {
    timestamp: r.timestamp,
    effort_level: typeof r.effort_level === "string" ? r.effort_level : "",
    task_description: r.task_description,
    criteria_count: typeof r.criteria_count === "number" ? r.criteria_count : 0,
    criteria_passed: typeof r.criteria_passed === "number" ? r.criteria_passed : 0,
    criteria_failed: typeof r.criteria_failed === "number" ? r.criteria_failed : 0,
    implied_sentiment: r.implied_sentiment,
    reflection_q1: typeof r.reflection_q1 === "string" ? r.reflection_q1 : "",
    reflection_q2: typeof r.reflection_q2 === "string" ? r.reflection_q2 : "",
    reflection_q3: typeof r.reflection_q3 === "string" ? r.reflection_q3 : "",
  };
}

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  if (isNaN(then)) return timestamp;
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return `${Math.floor(diffDay / 30)}mo ago`;
}

function sentimentClasses(sentiment: number): { border: string; bg: string; text: string } {
  if (sentiment >= 8) return { border: "border-emerald-500", bg: "bg-emerald-500", text: "text-emerald-400" };
  if (sentiment >= 5) return { border: "border-amber-500", bg: "bg-amber-500", text: "text-amber-400" };
  return { border: "border-rose-500", bg: "bg-rose-500", text: "text-rose-400" };
}

const INITIAL_VISIBLE = 20;
const LOAD_MORE_COUNT = 20;

export default function ReflectionInsightsFeed() {
  const { data, isLoading, error } = useReflections();
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        Loading reflections...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-40 text-rose-400 text-xs">
        Error: {error}
      </div>
    );
  }

  const reflections = useMemo(() => {
    const raw = data?.reflections ?? [];
    return raw
      .map(parseReflection)
      .filter((r): r is Reflection => r !== null);
  }, [data]);

  const sorted = useMemo(
    () =>
      [...reflections].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      ),
    [reflections]
  );

  if (reflections.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        No reflection data yet
      </div>
    );
  }

  const visible = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

  const total = reflections.length;
  const avgSentiment =
    total > 0
      ? (
          reflections.reduce((sum, r) => sum + r.implied_sentiment, 0) / total
        ).toFixed(1)
      : "0.0";

  return (
    <div className="space-y-3">
      {/* Summary header */}
      <div className="text-xs text-ink-2">
        Average self-assessed sentiment:{" "}
        <span className="font-mono font-medium text-ink-1">
          {avgSentiment}
        </span>{" "}
        across{" "}
        <span className="font-mono font-medium text-ink-1">{total}</span>{" "}
        sessions
      </div>

      {/* Reflection cards */}
      {visible.map((r, i) => (
        <ReflectionCard key={`${r.timestamp}-${i}`} reflection={r} />
      ))}

      {/* Show more */}
      {hasMore && (
        <button
          onClick={() => setVisibleCount((c) => c + LOAD_MORE_COUNT)}
          className="w-full py-2 text-xs text-ink-2 hover:text-ink-1 bg-[rgba(20,28,56,0.3)] rounded-lg border border-white/[0.04] transition-colors"
        >
          Show more ({sorted.length - visibleCount} remaining)
        </button>
      )}
    </div>
  );
}

function ReflectionCard({ reflection: r }: { reflection: Reflection }) {
  const sc = sentimentClasses(r.implied_sentiment);

  return (
    <div
      className={`bg-[rgba(20,28,56,0.5)] rounded-lg border-l-[3px] ${sc.border} p-3 space-y-2`}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[16px] font-bold text-ink-1 truncate">
            {r.task_description.length > 80
              ? r.task_description.slice(0, 80) + "..."
              : r.task_description}
          </p>
          <div className="flex items-center gap-2 mt-1">
            {/* Effort pill */}
            <span className="text-[13px] px-1.5 py-0.5 rounded-full bg-[rgba(26,36,68,0.6)] text-ink-1 font-medium">
              {r.effort_level}
            </span>
            {/* Criteria count */}
            <span className="text-[13px] text-ink-3 font-mono">
              {r.criteria_passed}/{r.criteria_count}
            </span>
          </div>
        </div>
        {/* Sentiment circle badge */}
        <div
          className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${sc.bg}`}
        >
          <span className="text-[13px] font-bold text-white">
            {r.implied_sentiment}
          </span>
        </div>
      </div>

      {/* Expandable sections */}
      <ExpandableSection
        icon={RotateCcw}
        heading="What I'd do differently"
        content={r.reflection_q1}
        colorClass={sc.text}
      />
      <ExpandableSection
        icon={Brain}
        heading="Smarter algorithm approach"
        content={r.reflection_q2}
        colorClass={sc.text}
      />
      <ExpandableSection
        icon={Sparkles}
        heading="Ideal AI approach"
        content={r.reflection_q3}
        colorClass={sc.text}
      />

      {/* Timestamp */}
      <div className="text-[13px] text-ink-3 pt-1">
        {formatRelativeTime(r.timestamp)}
      </div>
    </div>
  );
}

function ExpandableSection({
  icon: Icon,
  heading,
  content,
  colorClass,
}: {
  icon: React.ComponentType<{ className?: string }>;
  heading: string;
  content: string;
  colorClass: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!content) return null;

  return (
    <div>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1.5 w-full text-left group"
      >
        <Icon className={`w-3 h-3 ${colorClass} opacity-60 shrink-0`} />
        <span className="text-[14px] text-ink-2 group-hover:text-ink-1 transition-colors">
          {heading}
        </span>
        <ChevronDown
          className={`w-3 h-3 text-ink-3 ml-auto transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <p className="text-[14px] text-ink-2 mt-1 pl-4.5 leading-relaxed">
          {content}
        </p>
      )}
    </div>
  );
}
