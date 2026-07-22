"use client";

import { useEffect, useRef, useCallback } from "react";
import * as d3 from "d3";

interface GraphNode {
  id: string;
  title: string;
  category: string;
  quality?: number;
  backlinkCount: number;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface KnowledgeGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (slug: string, category: string) => void;
  hiddenCategories?: Set<string>;
  searchQuery?: string;
  // When provided (memory-graph mode), color by this map (category=community id)
  // and lay out cluster centers dynamically on a ring instead of the 5 fixed domains.
  colorMap?: Record<string, string>;
}

const CATEGORY_COLORS: Record<string, string> = {
  "system-doc": "#22d3ee",
  person: "#38bdf8",
  company: "#fbbf24",
  idea: "#a78bfa",
  blog: "#f472b6",
  book: "#f87171",
};

export default function KnowledgeGraph({ nodes, edges, onNodeClick, hiddenCategories, searchQuery, colorMap }: KnowledgeGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    positions: Map<string, { x: number; y: number; r: number; category: string; title: string; backlinks: number }>;
    edgeList: Array<{ sx: number; sy: number; tx: number; ty: number }>;
    neighbors: Map<string, Set<string>>;
    transform: { x: number; y: number; k: number };
    focused: string | null;
    width: number;
    height: number;
  } | null>(null);

  const draw = useCallback(() => {
    if (!canvasRef.current || !containerRef.current || nodes.length === 0) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const canvas = canvasRef.current;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";

    // Filter nodes
    const visibleNodes = hiddenCategories?.size
      ? nodes.filter((n) => !hiddenCategories.has(n.category))
      : nodes;
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));

    // Build adjacency
    const neighbors = new Map<string, Set<string>>();
    for (const e of visibleEdges) {
      if (!neighbors.has(e.source)) neighbors.set(e.source, new Set());
      if (!neighbors.has(e.target)) neighbors.set(e.target, new Set());
      neighbors.get(e.source)!.add(e.target);
      neighbors.get(e.target)!.add(e.source);
    }

    // Category cluster centers. Default: 5 fixed domain centers (knowledge-graph mode).
    // colorMap mode (memory graph): lay distinct categories out on a ring so each
    // discovered community gets its own gravitational center.
    let cats: Record<string, { x: number; y: number }>;
    if (colorMap) {
      cats = {};
      const keys = Array.from(new Set(visibleNodes.map((n) => n.category)));
      const R = Math.min(width, height) * 0.38;
      keys.forEach((k, i) => {
        const a = (i / Math.max(keys.length, 1)) * Math.PI * 2;
        cats[k] = { x: width / 2 + Math.cos(a) * R, y: height / 2 + Math.sin(a) * R };
      });
    } else {
      cats = {
        "system-doc": { x: width * 0.25, y: height * 0.3 },
        person: { x: width * 0.75, y: height * 0.3 },
        company: { x: width * 0.25, y: height * 0.7 },
        idea: { x: width * 0.75, y: height * 0.7 },
        book: { x: width * 0.5, y: height * 0.5 },
      };
    }

    // Build simulation nodes with initial positions
    const simNodes = visibleNodes.map((n) => {
      const c = cats[n.category] || { x: width / 2, y: height / 2 };
      return {
        ...n,
        x: c.x + (Math.random() - 0.5) * width * 0.3,
        y: c.y + (Math.random() - 0.5) * height * 0.3,
      };
    });
    const nodeMap = new Map(simNodes.map((n) => [n.id, n]));
    const simEdges = visibleEdges
      .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    const nodeCount = simNodes.length;
    const edgeRatio = simEdges.length / Math.max(nodeCount, 1);
    const isSparse = edgeRatio < 0.1;
    const pad = 20;

    // PRE-COMPUTE layout synchronously — no live simulation
    const simulation = d3
      .forceSimulation(simNodes as any)
      .force("link", d3.forceLink(simEdges as any).id((d: any) => d.id).distance(isSparse ? 15 : 50))
      .force("charge", d3.forceManyBody().strength(isSparse ? -5 : -80))
      .force("x", d3.forceX((d: any) => (cats[d.category]?.x ?? width / 2)).strength(0.15))
      .force("y", d3.forceY((d: any) => (cats[d.category]?.y ?? height / 2)).strength(0.15))
      .force("collision", d3.forceCollide().radius((d: any) => Math.max(3, Math.sqrt(d.backlinkCount || 1) * 2 + 2)))
      .velocityDecay(0.5)
      .alphaDecay(0.05)
      .stop();

    // Run 200 ticks synchronously
    for (let i = 0; i < 200; i++) {
      simulation.tick();
      for (const d of simNodes as any[]) {
        d.x = Math.max(pad, Math.min(width - pad, d.x));
        d.y = Math.max(pad, Math.min(height - pad, d.y));
      }
    }

    // Store pre-computed positions
    const positions = new Map<string, { x: number; y: number; r: number; category: string; title: string; backlinks: number }>();
    for (const n of simNodes as any[]) {
      positions.set(n.id, {
        x: n.x,
        y: n.y,
        r: Math.max(3, Math.sqrt(n.backlinkCount || 1) * 2.5 + 2),
        category: n.category,
        title: n.title,
        backlinks: n.backlinkCount,
      });
    }

    // Store edge coordinates
    const edgeList: Array<{ sx: number; sy: number; tx: number; ty: number }> = [];
    for (const e of simEdges as any[]) {
      const s = typeof e.source === "string" ? positions.get(e.source) : positions.get(e.source.id);
      const t = typeof e.target === "string" ? positions.get(e.target) : positions.get(e.target.id);
      if (s && t) edgeList.push({ sx: s.x, sy: s.y, tx: t.x, ty: t.y });
    }

    // Save state for interaction
    stateRef.current = {
      positions,
      edgeList,
      neighbors,
      transform: { x: 0, y: 0, k: 1 },
      focused: null,
      width,
      height,
    };

    // Render
    render();

    // Search: auto-focus first match
    if (searchQuery && searchQuery.length >= 2) {
      const q = searchQuery.toLowerCase();
      for (const [id, pos] of positions) {
        if (pos.title.toLowerCase().includes(q)) {
          stateRef.current.focused = id;
          stateRef.current.transform = {
            x: width / 2 - pos.x * 3,
            y: height / 2 - pos.y * 3,
            k: 3,
          };
          render();
          break;
        }
      }
    }
  }, [nodes, edges, hiddenCategories, searchQuery, onNodeClick, colorMap]);

  const render = useCallback(() => {
    const state = stateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { transform, positions, edgeList, neighbors, focused, width, height } = state;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const focusNeighbors = focused ? neighbors.get(focused) || new Set() : null;

    // Edges
    ctx.lineWidth = 0.5 / transform.k;
    for (const e of edgeList) {
      if (focused) {
        // Check if edge connects to focused node
        let connects = false;
        for (const [id, pos] of positions) {
          if (id === focused && (Math.abs(pos.x - e.sx) < 0.1 && Math.abs(pos.y - e.sy) < 0.1 ||
              Math.abs(pos.x - e.tx) < 0.1 && Math.abs(pos.y - e.ty) < 0.1)) {
            connects = true;
            break;
          }
        }
        ctx.strokeStyle = connects ? "rgba(148,163,184,0.5)" : "rgba(51,65,85,0.05)";
        ctx.lineWidth = connects ? 1.5 / transform.k : 0.5 / transform.k;
      } else {
        ctx.strokeStyle = "rgba(51,65,85,0.25)";
        ctx.lineWidth = 0.5 / transform.k;
      }
      ctx.beginPath();
      ctx.moveTo(e.sx, e.sy);
      ctx.lineTo(e.tx, e.ty);
      ctx.stroke();
    }

    // Nodes
    for (const [id, pos] of positions) {
      const isFocused = id === focused;
      const isNeighbor = focusNeighbors?.has(id);
      const dimmed = focused && !isFocused && !isNeighbor;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, pos.r, 0, Math.PI * 2);
      const color = colorMap?.[pos.category] || CATEGORY_COLORS[pos.category] || "#64748b";

      if (dimmed) {
        ctx.globalAlpha = 0.06;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = color;
        ctx.fill();
        if (isFocused) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2 / transform.k;
          ctx.stroke();
        }
      }
    }

    // Labels at zoom > 2x, or for focused + neighbors
    if (transform.k > 2 || focused) {
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const fontSize = Math.max(3, 10 / transform.k);
      ctx.font = `${fontSize}px 'concourse-t3', sans-serif`;

      for (const [id, pos] of positions) {
        const isFocused = id === focused;
        const isNeighbor = focusNeighbors?.has(id);

        if (focused && !isFocused && !isNeighbor) continue;
        if (!focused && transform.k <= 2) continue;

        ctx.fillStyle = isFocused ? "#f1f5f9" : isNeighbor ? "#94a3b8" : "#64748b";
        const label = pos.title.length > 25 ? pos.title.slice(0, 22) + "..." : pos.title;
        ctx.fillText(label, pos.x, pos.y - pos.r - 2);
      }
    }

    ctx.restore();
  }, []);

  // Mouse interaction
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isDragging = false;
    let lastX = 0;
    let lastY = 0;

    function hitTest(mx: number, my: number): string | null {
      const state = stateRef.current;
      if (!state) return null;
      const { transform, positions } = state;
      const wx = (mx - transform.x) / transform.k;
      const wy = (my - transform.y) / transform.k;

      let closest: string | null = null;
      let closestDist = Infinity;
      for (const [id, pos] of positions) {
        const dx = pos.x - wx;
        const dy = pos.y - wy;
        const dist = dx * dx + dy * dy;
        const hitR = Math.max(pos.r + 3, 8 / transform.k);
        if (dist < hitR * hitR && dist < closestDist) {
          closest = id;
          closestDist = dist;
        }
      }
      return closest;
    }

    // Tooltip element
    const tooltipEl = document.createElement("div");
    tooltipEl.className = "graph-tooltip";
    Object.assign(tooltipEl.style, {
      position: "absolute",
      pointerEvents: "none",
      background: "rgba(2, 6, 23, 0.95)",
      border: "1px solid rgba(51, 65, 85, 0.5)",
      borderRadius: "8px",
      padding: "8px 12px",
      opacity: "0",
      zIndex: "100",
      backdropFilter: "blur(8px)",
      fontFamily: "'concourse-t3', sans-serif",
      transition: "opacity 0.15s",
    });
    canvas.parentElement?.appendChild(tooltipEl);

    function showTooltip(id: string, mx: number, my: number) {
      const state = stateRef.current;
      if (!state) return;
      const pos = state.positions.get(id);
      if (!pos) return;
      const color = colorMap?.[pos.category] || CATEGORY_COLORS[pos.category] || "#94a3b8";
      tooltipEl.innerHTML =
        `<div style="font-family: 'advocate-c14', sans-serif; font-size: 10px; letter-spacing: 0.05em; color: ${color}">${pos.category.replace("-", " ").toUpperCase()}</div>` +
        `<div style="font-size: 12px; color: #f1f5f9; margin-top: 2px">${pos.title}</div>` +
        (pos.backlinks > 0 ? `<div style="font-size: 10px; color: #64748b; margin-top: 2px">${pos.backlinks} backlinks</div>` : "") +
        `<div style="font-size: 9px; color: #475569; margin-top: 3px">${state.focused === id ? "click again to open" : "click to focus"}</div>`;
      tooltipEl.style.opacity = "1";
      tooltipEl.style.left = mx + 12 + "px";
      tooltipEl.style.top = my - 12 + "px";
    }

    function hideTooltip() {
      tooltipEl.style.opacity = "0";
    }

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const state = stateRef.current;
      if (!state) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newK = Math.max(0.3, Math.min(8, state.transform.k * factor));
      state.transform.x = mx - (mx - state.transform.x) * (newK / state.transform.k);
      state.transform.y = my - (my - state.transform.y) * (newK / state.transform.k);
      state.transform.k = newK;
      render();
    }

    function handleMouseDown(e: MouseEvent) {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }

    function handleMouseMove(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (isDragging) {
        const state = stateRef.current;
        if (!state) return;
        state.transform.x += e.clientX - lastX;
        state.transform.y += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        render();
        hideTooltip();
        return;
      }

      const id = hitTest(mx, my);
      canvas.style.cursor = id ? "pointer" : "grab";
      if (id) showTooltip(id, mx, my);
      else hideTooltip();
    }

    function handleMouseUp() {
      isDragging = false;
    }

    function handleClick(e: MouseEvent) {
      const state = stateRef.current;
      if (!state) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const id = hitTest(mx, my);

      if (id) {
        if (state.focused === id) {
          // Second click — navigate
          const pos = state.positions.get(id);
          if (pos && onNodeClick) onNodeClick(id, pos.category);
        } else {
          // Focus
          state.focused = id;
          const pos = state.positions.get(id)!;
          const targetK = 3;
          state.transform = {
            x: state.width / 2 - pos.x * targetK,
            y: state.height / 2 - pos.y * targetK,
            k: targetK,
          };
          render();
        }
      } else if (state.focused) {
        // Unfocus
        state.focused = null;
        state.transform = { x: 0, y: 0, k: 1 };
        render();
      }
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("mouseleave", handleMouseUp);
    canvas.addEventListener("click", handleClick);

    return () => {
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("mousedown", handleMouseDown);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseup", handleMouseUp);
      canvas.removeEventListener("mouseleave", handleMouseUp);
      canvas.removeEventListener("click", handleClick);
      tooltipEl.remove();
    };
  }, [onNodeClick, render]);

  useEffect(() => {
    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [draw]);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-ground">
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
}
