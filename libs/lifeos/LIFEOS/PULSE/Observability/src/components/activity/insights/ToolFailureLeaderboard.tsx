"use client";

import { useState, useMemo } from "react";
import { useToolFailures } from "@/hooks/useObservabilityData";

// ─── Tool Failure Leaderboard (Widget 11) ───
// Ranked list of most-failing tools with counts, bars, and error patterns.

interface ToolFailureEvent {
  timestamp?: string;
  tool_name?: string;
  error?: string;
}

type TimeFilter = "all" | "24h";

export default function ToolFailureLeaderboard() {
  const { data, isLoading } = useToolFailures();
  const [filter, setFilter] = useState<TimeFilter>("all");

  const events = (data?.events ?? []) as ToolFailureEvent[];

  // Compute byTool and error patterns based on filter
  const { ranked, totalFiltered, recent24h } = useMemo(() => {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const filtered =
      filter === "24h"
        ? events.filter((e) => {
            if (!e.timestamp) return false;
            return new Date(e.timestamp).getTime() > oneDayAgo;
          })
        : events;

    // Count 24h for the badge (always computed)
    const r24h =
      filter === "all"
        ? events.filter((e) => {
            if (!e.timestamp) return false;
            return new Date(e.timestamp).getTime() > oneDayAgo;
          }).length
        : filtered.length;

    // Group by tool
    const byTool: Record<string, number> = {};
    const errorsByTool: Record<string, Record<string, number>> = {};

    for (const evt of filtered) {
      const toolName = evt.tool_name || "unknown";
      byTool[toolName] = (byTool[toolName] || 0) + 1;

      if (evt.error) {
        const errorKey = evt.error.slice(0, 60);
        if (!errorsByTool[toolName]) errorsByTool[toolName] = {};
        errorsByTool[toolName][errorKey] =
          (errorsByTool[toolName][errorKey] || 0) + 1;
      }
    }

    // Sort descending, take top 10
    const sorted = Object.entries(byTool)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const rankedList = sorted.map(([name, count], i) => {
      // Find most common error pattern for this tool
      const toolErrors = errorsByTool[name] || {};
      let topError = "";
      let topErrorCount = 0;
      for (const [errText, errCount] of Object.entries(toolErrors)) {
        if (errCount > topErrorCount) {
          topError = errText;
          topErrorCount = errCount;
        }
      }

      return { rank: i + 1, name, count, topError };
    });

    return {
      ranked: rankedList,
      totalFiltered: filtered.length,
      recent24h: r24h,
    };
  }, [events, filter]);

  const maxCount = ranked.length > 0 ? ranked[0].count : 1;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        Loading tool failures...
      </div>
    );
  }

  if (ranked.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-3 text-xs">
        No tool failures recorded
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink-1">
            Tool Failures
          </span>
          <span className="text-[13px] font-mono text-ink-3">
            {totalFiltered} total
          </span>
          <span className="px-1.5 py-0.5 rounded text-[13px] font-mono bg-rose-500/10 text-rose-400">
            last 24h: {recent24h}
          </span>
        </div>
        {/* Toggle */}
        <div className="flex items-center gap-1 bg-[rgba(20,28,56,0.5)] rounded p-0.5">
          <button
            onClick={() => setFilter("24h")}
            className={`px-2 py-0.5 rounded text-[13px] transition-colors ${
              filter === "24h"
                ? "bg-surface-3 text-ink-1"
                : "text-ink-3 hover:text-ink-2"
            }`}
          >
            Last 24h
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`px-2 py-0.5 rounded text-[13px] transition-colors ${
              filter === "all"
                ? "bg-surface-3 text-ink-1"
                : "text-ink-3 hover:text-ink-2"
            }`}
          >
            All time
          </button>
        </div>
      </div>

      {/* Ranked list */}
      <div className="space-y-1.5">
        {ranked.map((item) => {
          const barWidth = Math.max(
            4,
            Math.round((item.count / maxCount) * 200)
          );
          const barColor =
            item.rank <= 3
              ? "bg-rose-500"
              : item.rank <= 7
                ? "bg-amber-500"
                : "bg-ink-2";

          return (
            <div key={item.name}>
              <div className="flex items-center gap-2">
                {/* Rank */}
                <span className="w-5 text-right text-xs font-mono text-ink-3 shrink-0">
                  {item.rank}
                </span>
                {/* Tool name */}
                <span className="w-28 text-sm font-mono text-ink-1 truncate shrink-0">
                  {item.name}
                </span>
                {/* Bar */}
                <div className="flex-1 flex items-center gap-2">
                  <div
                    className={`h-3 rounded-sm ${barColor}`}
                    style={{ width: `${barWidth}px`, maxWidth: "200px" }}
                  />
                  {/* Count */}
                  <span className="text-xs font-mono text-ink-2 shrink-0">
                    {item.count}
                  </span>
                </div>
              </div>
              {/* Error pattern */}
              {item.topError && (
                <div className="ml-7 pl-28 text-[13px] text-ink-3 truncate">
                  {item.topError}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
