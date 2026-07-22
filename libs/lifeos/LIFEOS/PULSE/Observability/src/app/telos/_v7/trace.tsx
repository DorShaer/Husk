"use client";

// Bidirectional trace modal — click any primitive, see up and down.

import { useEffect } from "react";
import type { Telos } from "./data";
import { Icons } from "./icons";

interface TraceNode {
  kind: string;
  id: string;
  title: string;
  meta?: string;
}

interface TraceItem {
  kind: string;
  id: string;
  title: string;
}

interface TracesResult {
  node: TraceNode | null;
  up: TraceItem[];
  down: TraceItem[];
}

interface HasIdAndLabel {
  id: string;
  title?: string;
  label?: string;
  name?: string;
}

function push(arr: TraceItem[], kind: string, item: HasIdAndLabel | undefined): void {
  if (!item) return;
  arr.push({
    kind,
    id: item.id,
    title: item.title ?? item.label ?? item.name ?? item.id,
  });
}

function tracesFor(telos: Telos, id: string | null): TracesResult {
  const up: TraceItem[] = [];
  const down: TraceItem[] = [];
  if (!id) return { node: null, up, down };

  // Dimension
  const dim = telos.dimensions.find((x) => x.id === id);
  if (dim) {
    push(up, "Ideal State", { id: "IDEAL", title: telos.idealState.horizon });
    telos.goals.filter((g) => g.dims.includes(id)).forEach((g) => push(down, "Goal", g));
    return { node: { kind: "Dimension", id, title: dim.label, meta: `${dim.cur} → ${dim.ideal}` }, up, down };
  }
  // Problem
  const prob = telos.problems.find((x) => x.id === id);
  if (prob) {
    telos.missions
      .filter((m) => (m.addresses ?? []).includes(id))
      .forEach((m) => push(down, "Mission", m));
    return { node: { kind: "Problem", id, title: prob.title, meta: prob.note }, up: [], down };
  }
  // Mission
  const mis = telos.missions.find((x) => x.id === id);
  if (mis) {
    (mis.addresses ?? []).forEach((pid) =>
      push(up, "Problem", telos.problems.find((p) => p.id === pid)),
    );
    telos.goals.forEach((g) => push(down, "Goal", g));
    return { node: { kind: "Mission", id, title: mis.title, meta: mis.horizon }, up, down };
  }
  // Goal
  const g = telos.goals.find((x) => x.id === id);
  if (g) {
    telos.missions.filter((m) => m.active).forEach((m) => push(up, "Mission", m));
    g.metrics.forEach((mid) =>
      push(down, "Metric", telos.metrics.find((x) => x.id === mid)),
    );
    telos.challenges.filter((c) => c.blocks.includes(id)).forEach((c) => push(up, "Challenge", c));
    telos.strategies.filter((s) => s.implements.includes(id)).forEach((s) => push(down, "Strategy", s));
    return { node: { kind: "Goal", id, title: g.title, meta: `${g.kpi} → ${g.target}` }, up, down };
  }
  // Metric
  const m = telos.metrics.find((x) => x.id === id);
  if (m) {
    m.feeds.forEach((gid) => push(up, "Goal", telos.goals.find((x) => x.id === gid)));
    return { node: { kind: "Metric", id, title: m.label, meta: `${m.value}${m.unit}` }, up, down };
  }
  // Challenge
  const c = telos.challenges.find((x) => x.id === id);
  if (c) {
    c.blocks.forEach((gid) => push(up, "Goal", telos.goals.find((x) => x.id === gid)));
    telos.strategies.filter((s) => s.overcomes.includes(id)).forEach((s) => push(down, "Strategy", s));
    return { node: { kind: "Challenge", id, title: c.title, meta: c.note }, up, down };
  }
  // Strategy
  const s = telos.strategies.find((x) => x.id === id);
  if (s) {
    s.overcomes.forEach((cid) =>
      push(up, "Challenge", telos.challenges.find((x) => x.id === cid)),
    );
    s.implements.forEach((gid) =>
      push(up, "Goal", telos.goals.find((x) => x.id === gid)),
    );
    telos.projects.filter((p) => p.strategy === id).forEach((p) => push(down, "Project", p));
    const parts = s.title.split("—").map((x) => x?.trim());
    return {
      node: {
        kind: "Strategy",
        id,
        title: parts[0] ?? s.title,
        meta: parts[1],
      },
      up,
      down,
    };
  }
  // Project
  const pr = telos.projects.find((x) => x.id === id);
  if (pr) {
    push(up, "Strategy", telos.strategies.find((x) => x.id === pr.strategy));
    pr.work.forEach((w) => push(down, "Work", w));
    (pr.team ?? []).forEach((tid) =>
      push(down, "Team", telos.team.find((t) => t.id === tid)),
    );
    return { node: { kind: "Project", id, title: pr.title, meta: pr.status }, up, down };
  }
  // Work
  const workWithProject = telos.projects.flatMap((p) =>
    p.work.map((w) => ({ ...w, project: p })),
  );
  const work = workWithProject.find((x) => x.id === id);
  if (work) {
    push(up, "Project", work.project);
    push(up, "Strategy", telos.strategies.find((x) => x.id === work.strategy));
    const owner = telos.team.find((t) => t.avatar === work.owner);
    if (owner) push(down, "Team", owner);
    return { node: { kind: "Work", id, title: work.title, meta: `${work.eta} · ${work.status}` }, up, down };
  }
  // Team
  const t = telos.team.find((x) => x.id === id);
  if (t) {
    t.owns.forEach((pid) => push(down, "Project", telos.projects.find((p) => p.id === pid)));
    return { node: { kind: "Team", id, title: t.name, meta: t.role }, up, down };
  }
  // Budget
  const b = telos.budget.find((x) => x.id === id);
  if (b) {
    b.funds.forEach((fid) => {
      const proj = telos.projects.find((x) => x.id === fid);
      const goal = telos.goals.find((x) => x.id === fid);
      if (proj) push(down, "Project", proj);
      else if (goal) push(down, "Goal", goal);
    });
    return { node: { kind: "Budget", id, title: b.label, meta: `${b.value} / ${b.of}` }, up, down };
  }
  return { node: null, up, down };
}

interface TraceModalProps {
  telos: Telos;
  id: string | null;
  onTrace: (id: string | null) => void;
  onClose: () => void;
}

const KIND_COLORS: Record<string, string> = {
  "Ideal State": "var(--sky)",
  Dimension:    "var(--sky)",
  Problem:      "var(--bad)",
  Mission:      "var(--warm)",
  Goal:         "var(--ok)",
  Metric:       "var(--azure)",
  Challenge:    "var(--warm)",
  Strategy:     "var(--accent-2)",
  Project:      "var(--sky)",
  Work:         "var(--text-2)",
  Team:         "var(--accent-2)",
  Budget:       "var(--money)",
};

function colorFor(kind: string): string {
  return KIND_COLORS[kind] ?? "var(--text-2)";
}

interface GroupProps {
  title: string;
  arr: readonly TraceItem[];
  dir: string;
  onTrace: (id: string | null) => void;
}

function Group({ title, arr, dir, onTrace }: GroupProps) {
  return (
    <div className="tr-col">
      <div className="tr-col-head">{title}</div>
      {arr.length === 0 && <div className="tr-empty">nothing {dir}</div>}
      {arr.map((n, i) => (
        <button
          key={n.kind + n.id + i}
          className="tr-line"
          onClick={() => onTrace(n.id)}
          type="button"
        >
          <span className="tr-kind" style={{ color: colorFor(n.kind) }}>{n.kind}</span>
          <span className="tr-id mono">{n.id}</span>
          <span className="tr-title">{n.title}</span>
        </button>
      ))}
    </div>
  );
}

export function TraceModal({ telos, id, onTrace, onClose }: TraceModalProps) {
  useEffect(() => {
    if (!id) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [id, onClose]);

  if (!id) return null;
  const { node, up, down } = tracesFor(telos, id);
  if (!node) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal trace-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-head">
          <div>
            <div className="modal-eyebrow" style={{ color: colorFor(node.kind) }}>
              {node.kind} · trace both ways
            </div>
            <h2 className="modal-title">{node.title}</h2>
            <div className="trace-meta">
              {node.meta}{" "}
              <span className="mono" style={{ color: "var(--text-4)", marginLeft: 8 }}>{node.id}</span>
            </div>
          </div>
          <button className="modal-x" onClick={onClose} type="button" aria-label="Close">
            <Icons.X size={16} />
          </button>
        </header>
        <div className="trace-grid">
          <Group title="Upward · what it serves" arr={up} dir="above" onTrace={onTrace} />
          <Group title="Downward · what it requires" arr={down} dir="below" onTrace={onTrace} />
        </div>
      </div>
    </div>
  );
}
