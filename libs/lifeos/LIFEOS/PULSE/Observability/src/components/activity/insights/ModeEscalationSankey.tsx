"use client";

import { useState, useMemo } from "react";
import { useAlgorithmState } from "@/hooks/useAlgorithmState";
import type { AlgorithmState, SessionMode, ModeTransition } from "@/types/algorithm";

/**
 * Widget 16: ModeEscalationSankey
 *
 * Simplified 3-column vertical flow diagram showing how sessions
 * flow between modes: Start -> Peak -> End.
 * SVG-only, no external charting libraries.
 */

type Column = "start" | "peak" | "end";

const MODE_ORDER: Record<SessionMode, number> = {
  minimal: 0,
  native: 1,
  algorithm: 2,
};

const MODE_COLORS: Record<SessionMode, string> = {
  minimal: "#f59e0b", // amber-500
  native: "#3b82f6", // blue-500
  algorithm: "#a855f7", // purple-500
};

const MODE_LABELS: Record<SessionMode, string> = {
  minimal: "MINIMAL",
  native: "NATIVE",
  algorithm: "ALGORITHM",
};

const ALL_MODES: SessionMode[] = ["minimal", "native", "algorithm"];

interface SessionFlow {
  startMode: SessionMode;
  peakMode: SessionMode;
  endMode: SessionMode;
}

interface FlowEdge {
  from: SessionMode;
  to: SessionMode;
  fromColumn: Column;
  toColumn: Column;
  count: number;
}

interface NodeLayout {
  mode: SessionMode;
  column: Column;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

function inferMode(session: AlgorithmState): SessionMode {
  if (session.currentMode) return session.currentMode;
  if (session.mode === "native") return "native";
  if (session.mode === "interactive" || session.mode === "starting") return "algorithm";
  if (session.criteria?.length > 0 || session.phaseHistory?.length > 0) return "algorithm";
  return "native";
}

function peakMode(modes: SessionMode[]): SessionMode {
  let peak: SessionMode = "minimal";
  for (const m of modes) {
    if (MODE_ORDER[m] > MODE_ORDER[peak]) {
      peak = m;
    }
  }
  return peak;
}

function analyzeSession(session: AlgorithmState): SessionFlow {
  const modeHistory: ModeTransition[] = session.modeHistory ?? [];

  if (modeHistory.length > 0) {
    const modes = modeHistory.map((t) => t.mode);
    return {
      startMode: modes[0],
      peakMode: peakMode(modes),
      endMode: modes[modes.length - 1],
    };
  }

  // Fallback: infer from single mode field
  const current = inferMode(session);
  return {
    startMode: current,
    peakMode: current,
    endMode: current,
  };
}

function buildFlowEdges(
  flows: SessionFlow[]
): { startToPeak: FlowEdge[]; peakToEnd: FlowEdge[] } {
  const s2p = new Map<string, number>();
  const p2e = new Map<string, number>();

  for (const f of flows) {
    const k1 = `${f.startMode}-${f.peakMode}`;
    s2p.set(k1, (s2p.get(k1) ?? 0) + 1);

    const k2 = `${f.peakMode}-${f.endMode}`;
    p2e.set(k2, (p2e.get(k2) ?? 0) + 1);
  }

  const startToPeak: FlowEdge[] = [];
  for (const [key, count] of s2p) {
    const [from, to] = key.split("-") as [SessionMode, SessionMode];
    startToPeak.push({ from, to, fromColumn: "start", toColumn: "peak", count });
  }

  const peakToEnd: FlowEdge[] = [];
  for (const [key, count] of p2e) {
    const [from, to] = key.split("-") as [SessionMode, SessionMode];
    peakToEnd.push({ from, to, fromColumn: "peak", toColumn: "end", count });
  }

  return { startToPeak, peakToEnd };
}

function FlowPath({
  edge,
  nodes,
  totalSessions,
  isHovered,
  onHover,
  onLeave,
  gradientId,
}: {
  edge: FlowEdge;
  nodes: NodeLayout[];
  totalSessions: number;
  isHovered: boolean;
  onHover: () => void;
  onLeave: () => void;
  gradientId: string;
}) {
  const fromNode = nodes.find(
    (n) => n.mode === edge.from && n.column === edge.fromColumn
  );
  const toNode = nodes.find(
    (n) => n.mode === edge.to && n.column === edge.toColumn
  );

  if (!fromNode || !toNode) return null;

  const pathWidth = Math.max(2, (edge.count / Math.max(totalSessions, 1)) * 40);

  // Calculate y positions within nodes (distribute flows vertically)
  const fromCenterY = fromNode.y + fromNode.height / 2;
  const toCenterY = toNode.y + toNode.height / 2;

  const fromX = fromNode.x + fromNode.width;
  const toX = toNode.x;

  // Cubic bezier control points
  const cpOffset = (toX - fromX) * 0.5;

  const d = `M ${fromX} ${fromCenterY} C ${fromX + cpOffset} ${fromCenterY}, ${toX - cpOffset} ${toCenterY}, ${toX} ${toCenterY}`;

  return (
    <g
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      style={{ cursor: "default" }}
    >
      {/* Wider invisible hit area */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={pathWidth + 10} />
      <path
        d={d}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={pathWidth}
        strokeLinecap="round"
        opacity={isHovered ? 0.6 : 0.3}
        className="transition-opacity duration-150"
      />
      {/* Flow count tooltip on hover */}
      {isHovered && (
        <text
          x={(fromX + toX) / 2}
          y={(fromCenterY + toCenterY) / 2 - pathWidth / 2 - 6}
          textAnchor="middle"
          fontSize={10}
          fill="#d4d4d8"
          fontWeight={500}
        >
          {edge.count}
        </text>
      )}
    </g>
  );
}

export default function ModeEscalationSankey() {
  const { algorithmStates, isLoading } = useAlgorithmState();
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

  const { flows, nodes, edges, allSameMode, dominantMode, totalSessions } =
    useMemo(() => {
      const sessionFlows = algorithmStates.map(analyzeSession);
      const total = sessionFlows.length;

      // Check if all sessions have the same mode everywhere
      if (total > 0) {
        const first = sessionFlows[0];
        const allSame = sessionFlows.every(
          (f) =>
            f.startMode === first.startMode &&
            f.peakMode === first.startMode &&
            f.endMode === first.startMode
        );
        if (allSame) {
          return {
            flows: sessionFlows,
            nodes: [],
            edges: { startToPeak: [], peakToEnd: [] },
            allSameMode: true,
            dominantMode: first.startMode,
            totalSessions: total,
          };
        }
      }

      // Count sessions per mode per column
      const columnCounts: Record<Column, Map<SessionMode, number>> = {
        start: new Map(),
        peak: new Map(),
        end: new Map(),
      };

      for (const f of sessionFlows) {
        columnCounts.start.set(
          f.startMode,
          (columnCounts.start.get(f.startMode) ?? 0) + 1
        );
        columnCounts.peak.set(
          f.peakMode,
          (columnCounts.peak.get(f.peakMode) ?? 0) + 1
        );
        columnCounts.end.set(
          f.endMode,
          (columnCounts.end.get(f.endMode) ?? 0) + 1
        );
      }

      // Layout nodes
      const svgWidth = 600;
      const svgHeight = 300;
      const nodeWidth = 100;
      const columnX: Record<Column, number> = {
        start: 40,
        peak: svgWidth / 2 - nodeWidth / 2,
        end: svgWidth - nodeWidth - 40,
      };
      const nodeGap = 8;
      const headerHeight = 20;
      const availableHeight = svgHeight - headerHeight - 20;

      const layoutNodes: NodeLayout[] = [];
      const columns: Column[] = ["start", "peak", "end"];

      for (const col of columns) {
        const counts = columnCounts[col];
        const activeModes = ALL_MODES.filter((m) => (counts.get(m) ?? 0) > 0);
        const totalInCol = activeModes.reduce(
          (s, m) => s + (counts.get(m) ?? 0),
          0
        );
        const totalGaps = Math.max(0, activeModes.length - 1) * nodeGap;
        const usableHeight = availableHeight - totalGaps;

        let currentY = headerHeight + 10;

        for (const mode of activeModes) {
          const count = counts.get(mode) ?? 0;
          const height = Math.max(
            30,
            (count / Math.max(totalInCol, 1)) * usableHeight
          );

          layoutNodes.push({
            mode,
            column: col,
            count,
            x: columnX[col],
            y: currentY,
            width: nodeWidth,
            height,
          });

          currentY += height + nodeGap;
        }
      }

      const e = buildFlowEdges(sessionFlows);

      return {
        flows: sessionFlows,
        nodes: layoutNodes,
        edges: e,
        allSameMode: false,
        dominantMode: "native" as SessionMode,
        totalSessions: total,
      };
    }, [algorithmStates]);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="h-[340px] flex items-center justify-center">
          <div className="w-full h-[300px] bg-[rgba(20,28,56,0.5)] rounded animate-pulse" />
        </div>
      </div>
    );
  }

  if (totalSessions === 0) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Mode Escalation Flow
        </h3>
        <div className="flex items-center justify-center py-8">
          <p className="text-xs text-ink-3">No session data available</p>
        </div>
      </div>
    );
  }

  if (allSameMode) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Mode Escalation Flow
        </h3>
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: MODE_COLORS[dominantMode] }}
          />
          <p className="text-sm text-ink-1 font-medium">
            All sessions: {MODE_LABELS[dominantMode]} ({totalSessions})
          </p>
          <p className="text-[14px] text-ink-3">
            No mode escalation detected
          </p>
        </div>
      </div>
    );
  }

  const svgWidth = 600;
  const svgHeight = 300;

  const allEdges = [...edges.startToPeak, ...edges.peakToEnd];

  return (
    <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
      <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
        Mode Escalation Flow
      </h3>

      <svg
        width="100%"
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full"
      >
        <defs>
          {/* Gradients for flow paths */}
          {allEdges.map((edge, i) => (
            <linearGradient
              key={`grad-${i}`}
              id={`sankey-grad-${i}`}
              x1="0"
              y1="0"
              x2="1"
              y2="0"
            >
              <stop offset="0%" stopColor={MODE_COLORS[edge.from]} />
              <stop offset="100%" stopColor={MODE_COLORS[edge.to]} />
            </linearGradient>
          ))}
        </defs>

        {/* Column headers */}
        {[
          { label: "Start", x: 90 },
          { label: "Peak", x: svgWidth / 2 },
          { label: "End", x: svgWidth - 90 },
        ].map((header) => (
          <text
            key={header.label}
            x={header.x}
            y={14}
            textAnchor="middle"
            fontSize={11}
            fill="var(--ink-2)"
          >
            {header.label}
          </text>
        ))}

        {/* Flow paths (rendered behind nodes) */}
        {allEdges.map((edge, i) => {
          const edgeKey = `${edge.fromColumn}-${edge.from}-${edge.toColumn}-${edge.to}`;
          const anyHovered = hoveredEdge !== null;
          const thisHovered = hoveredEdge === edgeKey;

          return (
            <FlowPath
              key={`flow-${i}`}
              edge={edge}
              nodes={nodes}
              totalSessions={totalSessions}
              isHovered={anyHovered ? thisHovered : true}
              onHover={() => setHoveredEdge(edgeKey)}
              onLeave={() => setHoveredEdge(null)}
              gradientId={`sankey-grad-${i}`}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const cornerRadius = 6;
          return (
            <g key={`node-${node.column}-${node.mode}`}>
              <rect
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx={cornerRadius}
                ry={cornerRadius}
                fill={MODE_COLORS[node.mode]}
                opacity={0.2}
                stroke={MODE_COLORS[node.mode]}
                strokeWidth={1}
                strokeOpacity={0.4}
              />
              {/* Mode label + count inside node */}
              {node.height >= 30 && (
                <>
                  <text
                    x={node.x + node.width / 2}
                    y={node.y + node.height / 2 - (node.height > 50 ? 6 : 0)}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={10}
                    fill="#e4e4e7"
                    fontWeight={500}
                  >
                    {MODE_LABELS[node.mode]}
                  </text>
                  {node.height > 50 && (
                    <text
                      x={node.x + node.width / 2}
                      y={node.y + node.height / 2 + 10}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={12}
                      fill="#d4d4d8"
                      fontWeight={600}
                      fontFamily="monospace"
                    >
                      {node.count}
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
