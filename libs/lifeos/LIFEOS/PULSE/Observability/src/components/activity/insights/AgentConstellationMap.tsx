"use client";

import { useState, useMemo } from "react";
import { useSubagentEvents } from "@/hooks/useObservabilityData";

/**
 * Widget 3: AgentConstellationMap
 *
 * Circular network visualization showing sessions (inner ring)
 * and their spawned subagents (outer ring) as a constellation.
 * Uses basic trigonometry for positioning — no external libraries.
 */

// ─── Types ───

interface SubagentEvent {
  session_id?: string;
  subagent_id?: string;
  subagent_type?: string;
  model?: string;
  prompt?: string;
  timestamp?: string | number;
  [key: string]: unknown;
}

interface SessionNode {
  sessionId: string;
  agents: AgentNode[];
  angle: number;
  x: number;
  y: number;
}

interface AgentNode {
  id: string;
  type: string;
  model: string;
  prompt: string;
  angle: number;
  x: number;
  y: number;
}

// ─── Constants ───

const AGENT_TYPE_COLORS: Record<string, { label: string; hex: string }> = {
  Researcher: { label: "Researcher", hex: "#22d3ee" }, // cyan-400
  Explore: { label: "Explore", hex: "#34d399" },       // emerald-400
};

const DEFAULT_AGENT_COLOR = "var(--ink-2)"; // zinc-400

const SVG_WIDTH = 500;
const SVG_HEIGHT = 350;
const CENTER_X = SVG_WIDTH / 2;
const CENTER_Y = SVG_HEIGHT / 2 - 10; // slight offset for legend room
const SESSION_RADIUS = 100;
const AGENT_RADIUS_MIN = 145;
const AGENT_RADIUS_MAX = 160;
const SESSION_NODE_SIZE = 14; // radius = 14 → 28px diameter
const AGENT_NODE_SIZE = 6;   // radius = 6 → 12px diameter
const MAX_SESSIONS = 20;

// ─── Helpers ───

function getAgentColor(type: string): string {
  // Case-insensitive match
  const normalized = Object.keys(AGENT_TYPE_COLORS).find(
    (k) => k.toLowerCase() === type.toLowerCase()
  );
  return normalized ? AGENT_TYPE_COLORS[normalized].hex : DEFAULT_AGENT_COLOR;
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len) + "\u2026";
}

function parseEvents(events: Array<Record<string, unknown>>): SubagentEvent[] {
  return events.map((e) => ({
    session_id: String(e.session_id ?? e.sessionId ?? ""),
    subagent_id: String(e.subagent_id ?? e.subagentId ?? e.id ?? ""),
    subagent_type: String(e.subagent_type ?? e.subagentType ?? e.type ?? "unknown"),
    model: String(e.model ?? ""),
    prompt: String(e.prompt ?? e.message ?? ""),
    timestamp: e.timestamp as string | number | undefined,
  }));
}

function buildConstellation(events: SubagentEvent[]): {
  sessions: SessionNode[];
  allAgentTypes: string[];
} {
  // Group by session
  const sessionMap = new Map<string, Map<string, SubagentEvent>>();
  for (const evt of events) {
    const sid = evt.session_id || "unknown";
    if (!sessionMap.has(sid)) sessionMap.set(sid, new Map());
    const agents = sessionMap.get(sid)!;
    const aid = evt.subagent_id || `${sid}-${agents.size}`;
    if (!agents.has(aid)) {
      agents.set(aid, evt);
    }
  }

  // Sort sessions by most recent event first, then limit
  const sortedSessions = Array.from(sessionMap.entries())
    .sort((a, b) => {
      const aLatest = Math.max(
        ...Array.from(a[1].values()).map((e) =>
          typeof e.timestamp === "number" ? e.timestamp : new Date(String(e.timestamp ?? 0)).getTime()
        )
      );
      const bLatest = Math.max(
        ...Array.from(b[1].values()).map((e) =>
          typeof e.timestamp === "number" ? e.timestamp : new Date(String(e.timestamp ?? 0)).getTime()
        )
      );
      return bLatest - aLatest;
    })
    .slice(0, MAX_SESSIONS);

  const sessionCount = sortedSessions.length;
  const allAgentTypes = new Set<string>();
  const sessions: SessionNode[] = [];

  sortedSessions.forEach(([sessionId, agentsMap], sessionIndex) => {
    const sessionAngle = (2 * Math.PI * sessionIndex) / sessionCount;
    const sx = CENTER_X + SESSION_RADIUS * Math.cos(sessionAngle);
    const sy = CENTER_Y + SESSION_RADIUS * Math.sin(sessionAngle);

    const agentEntries = Array.from(agentsMap.entries());
    const agents: AgentNode[] = agentEntries.map(([agentId, evt], agentIndex) => {
      const agentType = evt.subagent_type || "unknown";
      allAgentTypes.add(agentType);

      // Fan subagents around their parent session
      const agentCount = agentEntries.length;
      const spreadAngle = Math.min(0.3, (0.8 / sessionCount));
      const offsetAngle = agentCount > 1
        ? sessionAngle + spreadAngle * (agentIndex - (agentCount - 1) / 2)
        : sessionAngle;
      const agentRadius = AGENT_RADIUS_MIN + (agentIndex % 3) * ((AGENT_RADIUS_MAX - AGENT_RADIUS_MIN) / 2);

      return {
        id: agentId,
        type: agentType,
        model: evt.model || "",
        prompt: evt.prompt || "",
        angle: offsetAngle,
        x: CENTER_X + agentRadius * Math.cos(offsetAngle),
        y: CENTER_Y + agentRadius * Math.sin(offsetAngle),
      };
    });

    sessions.push({
      sessionId,
      agents,
      angle: sessionAngle,
      x: sx,
      y: sy,
    });
  });

  return {
    sessions,
    allAgentTypes: Array.from(allAgentTypes),
  };
}

// ─── Component ───

export default function AgentConstellationMap() {
  const { data, isLoading, error } = useSubagentEvents();
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [hoveredAgent, setHoveredAgent] = useState<AgentNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const parsed = useMemo(() => {
    if (!data?.events) return null;
    const events = parseEvents(data.events);
    if (events.length === 0) return null;
    return buildConstellation(events);
  }, [data]);

  // Count totals for summary
  const totalAgents = parsed?.sessions.reduce((sum, s) => sum + s.agents.length, 0) ?? 0;
  const totalSessions = parsed?.sessions.length ?? 0;

  // Gather legend types
  const legendTypes = useMemo(() => {
    if (!parsed) return [];
    const typesInUse = new Set<string>();
    for (const s of parsed.sessions) {
      for (const a of s.agents) {
        typesInUse.add(a.type);
      }
    }
    return Array.from(typesInUse).sort();
  }, [parsed]);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Agent Constellation
        </h3>
        <div className="flex items-center justify-center h-[350px]">
          <div className="w-48 h-48 rounded-full border-2 border-line-2 animate-pulse" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Agent Constellation
        </h3>
        <p className="text-xs text-rose-400">Failed to load: {error}</p>
      </div>
    );
  }

  if (!parsed || totalSessions === 0) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Agent Constellation
        </h3>
        <div className="flex flex-col items-center justify-center py-12">
          <svg width={80} height={80} viewBox="0 0 80 80">
            <circle cx={40} cy={40} r={30} fill="none" stroke="var(--line-1)" strokeWidth={2} strokeDasharray="4 4" />
            <circle cx={40} cy={40} r={3} fill="var(--line-1)" />
          </svg>
          <p className="text-xs text-ink-3 mt-3">No agent activity recorded</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider">
          Agent Constellation
        </h3>
        <span className="text-[14px] text-ink-3 font-mono tabular-nums">
          {totalAgents} agent{totalAgents !== 1 ? "s" : ""} across {totalSessions} session{totalSessions !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="relative">
        <svg
          width="100%"
          height={350}
          viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
          className="overflow-visible"
        >
          {/* Center label */}
          <text
            x={CENTER_X}
            y={CENTER_Y}
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-[var(--ink-3)]"
            fontSize={11}
            fontWeight={500}
          >
            LifeOS
          </text>

          {/* Edges: session → agents */}
          {parsed.sessions.map((session) =>
            session.agents.map((agent) => {
              const dimmed =
                hoveredSession !== null && hoveredSession !== session.sessionId;
              return (
                <line
                  key={`edge-${session.sessionId}-${agent.id}`}
                  x1={session.x}
                  y1={session.y}
                  x2={agent.x}
                  y2={agent.y}
                  stroke="var(--line-1)"
                  strokeWidth={1}
                  className="transition-opacity duration-150"
                  style={{
                    opacity: dimmed ? 0.08 : 0.4,
                  }}
                />
              );
            })
          )}

          {/* Session nodes (inner ring) */}
          {parsed.sessions.map((session) => {
            const isHovered = hoveredSession === session.sessionId;
            const isDimmed =
              hoveredSession !== null && !isHovered;

            return (
              <g
                key={`session-${session.sessionId}`}
                className="cursor-default"
                onMouseEnter={() => setHoveredSession(session.sessionId)}
                onMouseLeave={() => setHoveredSession(null)}
              >
                <circle
                  cx={session.x}
                  cy={session.y}
                  r={SESSION_NODE_SIZE}
                  fill={isHovered ? "var(--line-1)" : "var(--line-1)"}
                  stroke={isHovered ? "var(--ink-2)" : "var(--ink-3)"}
                  strokeWidth={isHovered ? 2 : 1.5}
                  className="transition-all duration-150"
                  style={{ opacity: isDimmed ? 0.3 : 1 }}
                />
                <text
                  x={session.x}
                  y={session.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="white"
                  fontSize={8}
                  className="pointer-events-none select-none"
                  style={{ opacity: isDimmed ? 0.3 : 1 }}
                >
                  {session.sessionId.slice(0, 4)}
                </text>
              </g>
            );
          })}

          {/* Agent nodes (outer ring) */}
          {parsed.sessions.map((session) =>
            session.agents.map((agent) => {
              const sessionDimmed =
                hoveredSession !== null && hoveredSession !== session.sessionId;
              const color = getAgentColor(agent.type);

              return (
                <circle
                  key={`agent-${agent.id}`}
                  cx={agent.x}
                  cy={agent.y}
                  r={AGENT_NODE_SIZE}
                  fill={color}
                  className="cursor-default transition-opacity duration-150"
                  style={{ opacity: sessionDimmed ? 0.15 : 1 }}
                  onMouseEnter={(e) => {
                    setHoveredAgent(agent);
                    const svgRect = (e.target as SVGElement).closest("svg")?.getBoundingClientRect();
                    if (svgRect) {
                      const scaleX = svgRect.width / SVG_WIDTH;
                      const scaleY = svgRect.height / SVG_HEIGHT;
                      setTooltipPos({
                        x: agent.x * scaleX,
                        y: agent.y * scaleY,
                      });
                    }
                  }}
                  onMouseLeave={() => setHoveredAgent(null)}
                />
              );
            })
          )}
        </svg>

        {/* Agent tooltip */}
        {hoveredAgent && (
          <div
            className="absolute z-50 px-2.5 py-1.5 rounded-md bg-surface-2 border border-white/[0.08] shadow-lg whitespace-nowrap pointer-events-none"
            style={{
              left: tooltipPos.x,
              top: tooltipPos.y - 8,
              transform: "translate(-50%, -100%)",
            }}
          >
            <p className="text-xs text-ink-1 font-medium capitalize">
              {hoveredAgent.type}
            </p>
            {hoveredAgent.model && (
              <p className="text-[13px] text-ink-3">
                Model: {hoveredAgent.model}
              </p>
            )}
            {hoveredAgent.prompt && (
              <p className="text-[13px] text-ink-3 max-w-[200px] truncate">
                {truncate(hoveredAgent.prompt, 80)}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 mt-2">
        {legendTypes.map((type) => (
          <div key={type} className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: getAgentColor(type) }}
            />
            <span className="text-[14px] text-ink-2 capitalize">{type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
