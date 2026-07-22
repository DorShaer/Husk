"use client";

import { useMemo } from "react";
import type { HookEvent } from "./useAgentEvents";
import type { ChartDataPoint, TimeRange } from "./useChartData";

// ─── Types ───

export interface TokenMetrics {
  input: number;
  output: number;
  total: number;
}

export interface ToolUsage {
  tool: string;
  count: number;
  skill?: string;
  healthIndicator?: string;
}

export interface SkillWorkflowUsage {
  name: string;
  type: "skill" | "workflow";
  count: number;
}

export interface AgentActivity {
  agent: string;
  count: number;
  percentage: number;
}

// ─── Token estimation heuristics ───

const TOKEN_ESTIMATES: Record<string, number> = {
  PostToolUse: 2000,
  PostAgentMessage: 1500,
  UserPromptSubmit: 500,
  PreToolUse: 300,
  SessionStart: 1000,
  SessionEnd: 200,
  default: 100,
};

// ─── Hook ───

export function useAdvancedMetrics(
  allEvents: HookEvent[],
  dataPoints: ChartDataPoint[],
  timeRange: TimeRange,
  currentConfig: { duration: number; bucketSize: number; maxPoints: number }
) {
  const eventsPerMinute = useMemo(() => {
    const total = dataPoints.reduce((sum, dp) => sum + dp.count, 0);
    const mins = currentConfig.duration / 60_000;
    if (mins === 0) return 0;
    return Number((total / mins).toFixed(2));
  }, [dataPoints, currentConfig.duration]);

  const totalTokens = useMemo<TokenMetrics>(() => {
    const now = Date.now();
    const cutoff = now - currentConfig.duration;
    const windowEvents = allEvents.filter((e) => e.timestamp && e.timestamp >= cutoff);

    let input = 0;
    let output = 0;

    for (const event of windowEvents) {
      const estimate = TOKEN_ESTIMATES[event.hook_event_type] || TOKEN_ESTIMATES.default;
      input += Math.floor(estimate * 0.4);
      output += Math.floor(estimate * 0.6);
    }

    return { input, output, total: input + output };
  }, [allEvents, currentConfig.duration]);

  const activeSessions = useMemo(() => {
    const now = Date.now();
    const cutoff = now - currentConfig.duration;
    const sessions = new Set<string>();
    allEvents.forEach((e) => {
      if (e.timestamp && e.timestamp >= cutoff) sessions.add(e.session_id);
    });
    return sessions.size;
  }, [allEvents, currentConfig.duration]);

  const topTools = useMemo<ToolUsage[]>(() => {
    const now = Date.now();
    const cutoff = now - currentConfig.duration;
    const toolData = new Map<string, { count: number; skill?: string; errors: number }>();

    allEvents.forEach((event) => {
      if (event.timestamp && event.timestamp >= cutoff) {
        if (event.hook_event_type === "PostToolUse" || event.hook_event_type === "PreToolUse") {
          const toolName = event.payload?.tool_name || event.payload?.tool || event.payload?.name || "unknown";
          const skillName = event.payload?.skill;

          if (!toolData.has(toolName)) {
            toolData.set(toolName, { count: 0, skill: skillName, errors: 0 });
          }
          const data = toolData.get(toolName)!;
          data.count++;

          if (event.payload?.error || event.payload?.status === "error") {
            data.errors++;
          }
          if (!data.skill && skillName) data.skill = skillName;
        }
      }
    });

    return Array.from(toolData.entries())
      .map(([tool, data]) => {
        let healthIndicator = "ok";
        if (data.errors > 0) healthIndicator = "warn";
        return { tool, count: data.count, skill: data.skill, healthIndicator };
      })
      .sort((a, b) => b.count - a.count);
  }, [allEvents, currentConfig.duration]);

  const skillsAndWorkflows = useMemo<SkillWorkflowUsage[]>(() => {
    const now = Date.now();
    const cutoff = now - currentConfig.duration;
    const usageMap = new Map<string, { type: "skill" | "workflow"; count: number }>();

    allEvents.forEach((event) => {
      if (event.timestamp && event.timestamp >= cutoff) {
        const toolName = event.payload?.tool_name;

        // Skill tool invocations
        if (
          (event.hook_event_type === "PostToolUse" || event.hook_event_type === "PreToolUse") &&
          toolName === "Skill"
        ) {
          const skillName = event.payload?.tool_input?.skill || "unknown";
          if (skillName !== "unknown") {
            const key = `skill:${skillName}`;
            if (!usageMap.has(key)) usageMap.set(key, { type: "skill", count: 0 });
            usageMap.get(key)!.count++;
          }
        }

        // Workflow detection from Bash commands
        if (event.hook_event_type === "PostToolUse" && event.payload?.tool_name === "Bash") {
          const command = event.payload?.tool_input?.command || "";
          const wfMatch = command.match(/\/SkillWorkflowNotification\s+(\w+)\s+(\w+)/);
          if (wfMatch) {
            const wfKey = `workflow:${wfMatch[1]}`;
            if (!usageMap.has(wfKey)) usageMap.set(wfKey, { type: "workflow", count: 0 });
            usageMap.get(wfKey)!.count++;

            const skKey = `skill:${wfMatch[2]}`;
            if (!usageMap.has(skKey)) usageMap.set(skKey, { type: "skill", count: 0 });
            usageMap.get(skKey)!.count++;
          }
        }

        // SlashCommand invocations
        if (
          (event.hook_event_type === "PostToolUse" || event.hook_event_type === "PreToolUse") &&
          event.payload?.tool_name === "SlashCommand"
        ) {
          const cmd = event.payload?.tool_input?.command || "";
          const match = cmd.match(/^\/(\w+)/);
          if (match) {
            const key = `workflow:${match[1]}`;
            if (!usageMap.has(key)) usageMap.set(key, { type: "workflow", count: 0 });
            usageMap.get(key)!.count++;
          }
        }
      }
    });

    return Array.from(usageMap.entries())
      .map(([key, data]) => {
        const [type, name] = key.split(":");
        return { name, type: type as "skill" | "workflow", count: data.count };
      })
      .sort((a, b) => b.count - a.count);
  }, [allEvents, currentConfig.duration]);

  const agentActivity = useMemo<AgentActivity[]>(() => {
    const now = Date.now();
    const cutoff = now - currentConfig.duration;
    const counts = new Map<string, number>();
    let total = 0;

    allEvents.forEach((e) => {
      if (e.timestamp && e.timestamp >= cutoff) {
        const key = e.agent_name || e.source_app || "unknown";
        counts.set(key, (counts.get(key) || 0) + 1);
        total++;
      }
    });

    return Array.from(counts.entries())
      .map(([agent, count]) => ({
        agent,
        count,
        percentage: total > 0 ? Number(((count / total) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }, [allEvents, currentConfig.duration]);

  // Estimated cost (Claude Opus 4 pricing: $15/1M input, $75/1M output)
  const estimatedCost = useMemo(() => {
    const inputCost = (totalTokens.input / 1_000_000) * 15;
    const outputCost = (totalTokens.output / 1_000_000) * 75;
    return inputCost + outputCost;
  }, [totalTokens]);

  return {
    eventsPerMinute,
    totalTokens,
    activeSessions,
    topTools,
    skillsAndWorkflows,
    agentActivity,
    estimatedCost,
  };
}
