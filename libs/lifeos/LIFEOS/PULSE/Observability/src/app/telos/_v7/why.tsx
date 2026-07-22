"use client";

// Why Band — human-first. Goals speak in sentences; IDs on toggle.
// NOTE: this component is defined for parity with v7 exports but is not currently
// rendered by app.tsx (v7 app.jsx didn't render it either).

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Challenge, Dimension, Goal, Strategy, Telos } from "./data";

function relatedFor(telos: Telos, hoverId: string | null): Set<string> {
  if (!hoverId) return new Set();
  const out = new Set<string>([hoverId]);
  const g = telos.goals.find((x) => x.id === hoverId);
  const c = telos.challenges.find((x) => x.id === hoverId);
  const s = telos.strategies.find((x) => x.id === hoverId);
  if (g) {
    telos.challenges.forEach((cc) => cc.blocks.includes(g.id) && out.add(cc.id));
    telos.strategies.forEach((ss) => ss.implements.includes(g.id) && out.add(ss.id));
  }
  if (c) {
    c.blocks.forEach((id) => out.add(id));
    telos.strategies.forEach((ss) => ss.overcomes.includes(c.id) && out.add(ss.id));
  }
  if (s) {
    s.overcomes.forEach((id) => out.add(id));
    s.implements.forEach((id) => out.add(id));
  }
  return out;
}

function sentenceCase(title: string): string {
  // titles in data.ts are already human-readable
  return title;
}

function progressLine(g: Goal): ReactNode {
  const trend =
    g.delta > 1.5 ? "trending up" :
    g.delta > 0   ? "inching up" :
    g.delta === 0 ? "holding" :
    g.delta > -1.5 ? "inching down" :
                     "trending down";
  return (
    <>
      {g.kpi} <span className="card-arrow">→</span> {g.target} <span className="card-trend">· {trend}</span>
    </>
  );
}

interface GoalCardProps {
  g: Goal;
  dim?: Dimension;
  hover: Set<string>;
  active: boolean;
  onHover: (id: string | null) => void;
  onOpen: (g: Goal) => void;
  showIds: boolean;
}

function GoalCard({ g, dim, hover, active, onHover, onOpen, showIds }: GoalCardProps) {
  const color = dim ? `var(${dim.color})` : "var(--accent)";
  const faded = hover.size > 0 && !active;
  return (
    <div
      className={"card goal" + (faded ? " faded" : "") + (active ? " active" : "")}
      onMouseEnter={() => onHover(g.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onOpen(g)}
    >
      <div className="card-row">
        {showIds && <span className="card-id mono" style={{ color }}>{g.id}</span>}
        <div className="card-title">{sentenceCase(g.title)}</div>
      </div>
      <div className="card-progress">{progressLine(g)}</div>
      <div className="bar"><div className="bar-fill" style={{ width: g.pct + "%", background: color }} /></div>
      <div className="card-foot">
        <div className="card-dims">
          {g.dims.map((d) => (
            <span key={d} className="dim-tag" style={{ ["--c" as string]: `var(--${d})` } as React.CSSProperties}>{d}</span>
          ))}
        </div>
        <span className="card-pct mono">{g.pct}%</span>
      </div>
    </div>
  );
}

interface ChallengeCardProps {
  c: Challenge;
  hover: Set<string>;
  active: boolean;
  onHover: (id: string | null) => void;
  showIds: boolean;
}

function ChallengeCard({ c, hover, active, onHover, showIds }: ChallengeCardProps) {
  const faded = hover.size > 0 && !active;
  return (
    <div
      className={"card challenge" + (faded ? " faded" : "") + (active ? " active" : "")}
      onMouseEnter={() => onHover(c.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="card-row">
        {showIds && <span className="card-id mono" style={{ color: "var(--warm)" }}>{c.id}</span>}
        <div className="card-title">{c.title}</div>
      </div>
      <div className="card-note">{c.note}</div>
      <div className="card-links">
        <span className="link-label">gets in the way of</span>
        <span className="link-count">{c.blocks.length} goals</span>
      </div>
    </div>
  );
}

interface StrategyCardProps {
  s: Strategy;
  hover: Set<string>;
  active: boolean;
  onHover: (id: string | null) => void;
  showIds: boolean;
}

function StrategyCard({ s, hover, active, onHover, showIds }: StrategyCardProps) {
  const faded = hover.size > 0 && !active;
  const parts = s.title.split("—").map((x) => x?.trim());
  const head = parts[0] ?? s.title;
  const rule = parts[1];
  return (
    <div
      className={"card strategy" + (faded ? " faded" : "") + (active ? " active" : "") + (s.active ? " current" : "")}
      onMouseEnter={() => onHover(s.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="card-row">
        {showIds && <span className="card-id mono" style={{ color: "var(--accent-2)" }}>{s.id}</span>}
        <div className="card-title">{head}</div>
        {s.active && <span className="badge-now">doing this</span>}
      </div>
      {rule && <div className="card-rule">{rule}</div>}
      <div className="card-links">
        <span className="link-label">answers</span>
        <span className="link-count">{s.overcomes.length} challenge{s.overcomes.length === 1 ? "" : "s"}</span>
        <span className="link-sep">·</span>
        <span className="link-label">pushes</span>
        <span className="link-count">{s.implements.length} goals</span>
      </div>
    </div>
  );
}

interface ColumnsViewProps {
  telos: Telos;
  hover: string | null;
  setHover: (id: string | null) => void;
  onOpenGoal: (g: Goal) => void;
  showIds: boolean;
}

function ColumnsView({ telos, hover, setHover, onOpenGoal, showIds }: ColumnsViewProps) {
  const rel = relatedFor(telos, hover);
  const dimMap: Record<string, Dimension> = Object.fromEntries(
    telos.dimensions.map((d) => [d.id, d]),
  );
  return (
    <div className="why-cols">
      <div className="col">
        <div className="col-head">
          <span>Goals</span>
          <span className="col-head-note">where you want to end up</span>
        </div>
        <div className="col-body">
          {telos.goals.map((g) => (
            <GoalCard
              key={g.id}
              g={g}
              dim={dimMap[g.dims[0]]}
              hover={rel}
              active={rel.has(g.id)}
              onHover={setHover}
              onOpen={onOpenGoal}
              showIds={showIds}
            />
          ))}
        </div>
      </div>
      <div className="col">
        <div className="col-head">
          <span>Challenges</span>
          <span className="col-head-note">what&rsquo;s in the way</span>
        </div>
        <div className="col-body">
          {telos.challenges.map((c) => (
            <ChallengeCard
              key={c.id}
              c={c}
              hover={rel}
              active={rel.has(c.id)}
              onHover={setHover}
              showIds={showIds}
            />
          ))}
        </div>
      </div>
      <div className="col">
        <div className="col-head">
          <span>Strategies</span>
          <span className="col-head-note">how we&rsquo;re answering</span>
        </div>
        <div className="col-body">
          {telos.strategies.map((s) => (
            <StrategyCard
              key={s.id}
              s={s}
              hover={rel}
              active={rel.has(s.id)}
              onHover={setHover}
              showIds={showIds}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface ForceViewProps {
  telos: Telos;
  hover: string | null;
  setHover: (id: string | null) => void;
  onOpenGoal: (g: Goal) => void;
}

interface ForceNode {
  id: string;
  kind: "G" | "C" | "S";
  label: string;
  title: string;
  x: number;
  y: number;
}

interface ForceLink {
  a: string;
  b: string;
  kind: "CG" | "SC" | "SG";
}

function ForceView({ telos, hover, setHover, onOpenGoal }: ForceViewProps) {
  const rel = relatedFor(telos, hover);
  const W = 1200;
  const H = 620;
  const colX = { G: 180, C: W / 2, S: W - 180 };
  const nodes = useMemo<ForceNode[]>(() => {
    const gs: ForceNode[] = telos.goals.map((g, i) => ({
      id: g.id,
      kind: "G",
      label: g.id,
      title: g.title,
      x: colX.G,
      y: 70 + i * (480 / Math.max(1, telos.goals.length - 1)),
    }));
    const cs: ForceNode[] = telos.challenges.map((c, i) => ({
      id: c.id,
      kind: "C",
      label: c.id,
      title: c.title,
      x: colX.C,
      y: 100 + i * (420 / Math.max(1, telos.challenges.length - 1)),
    }));
    const ss: ForceNode[] = telos.strategies.map((s, i) => ({
      id: s.id,
      kind: "S",
      label: s.id,
      title: s.title.split("—")[0].trim(),
      x: colX.S,
      y: 70 + i * (480 / Math.max(1, telos.strategies.length - 1)),
    }));
    return [...gs, ...cs, ...ss];
  }, [telos]);

  const nodeById: Record<string, ForceNode> = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const links: ForceLink[] = [];
  telos.challenges.forEach((c) => c.blocks.forEach((gid) => links.push({ a: c.id, b: gid, kind: "CG" })));
  telos.strategies.forEach((s) => {
    s.overcomes.forEach((cid) => links.push({ a: s.id, b: cid, kind: "SC" }));
    s.implements.forEach((gid) => links.push({ a: s.id, b: gid, kind: "SG" }));
  });

  const linkActive = (l: ForceLink): boolean => rel.size === 0 || (rel.has(l.a) && rel.has(l.b));

  return (
    <div className="force-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="force-svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="lg-cg" x1="0" x2="1">
            <stop offset="0" stopColor="var(--warm)" stopOpacity=".55" />
            <stop offset="1" stopColor="var(--text-4)" stopOpacity=".15" />
          </linearGradient>
          <linearGradient id="lg-sc" x1="0" x2="1">
            <stop offset="0" stopColor="var(--text-4)" stopOpacity=".15" />
            <stop offset="1" stopColor="var(--accent-2)" stopOpacity=".6" />
          </linearGradient>
          <linearGradient id="lg-sg" x1="0" x2="1">
            <stop offset="0" stopColor="var(--accent-2)" stopOpacity=".6" />
            <stop offset="1" stopColor="var(--ok)" stopOpacity=".45" />
          </linearGradient>
        </defs>

        {([
          ["Goals", colX.G, "var(--ok)"],
          ["Challenges", colX.C, "var(--sky)"],
          ["Strategies", colX.S, "var(--accent-2)"],
        ] as const).map(([t, x, c]) => (
          <g key={t}>
            <text
              x={x}
              y={36}
              textAnchor="middle"
              fill="var(--text-2)"
              fontSize="14"
              fontFamily="var(--sans)"
              fontWeight="500"
            >
              {t}
            </text>
            <line x1={x} y1={50} x2={x} y2={H - 20} stroke={c} strokeOpacity=".07" strokeDasharray="2 4" />
          </g>
        ))}

        {links.map((l, i) => {
          const a = nodeById[l.a];
          const b = nodeById[l.b];
          if (!a || !b) return null;
          const active = linkActive(l);
          const xm = (a.x + b.x) / 2;
          const d = `M ${a.x} ${a.y} C ${xm} ${a.y}, ${xm} ${b.y}, ${b.x} ${b.y}`;
          const grad = l.kind === "CG" ? "url(#lg-cg)" : l.kind === "SC" ? "url(#lg-sc)" : "url(#lg-sg)";
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={grad}
              strokeWidth={active ? 1.4 : 0.7}
              strokeOpacity={active ? 1 : 0.22}
            />
          );
        })}

        {nodes.map((n) => {
          const active = rel.size === 0 || rel.has(n.id);
          const color =
            n.kind === "G" ? "var(--ok)" : n.kind === "C" ? "var(--warm)" : "var(--accent-2)";
          return (
            <g
              key={n.id}
              style={{ cursor: n.kind === "G" ? "pointer" : "default", opacity: active ? 1 : 0.25, transition: "opacity 180ms" }}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => {
                if (n.kind !== "G") return;
                const goal = telos.goals.find((g) => g.id === n.id);
                if (goal) onOpenGoal(goal);
              }}
            >
              <rect
                x={n.x - 90}
                y={n.y - 15}
                width="180"
                height="30"
                rx="4"
                fill="var(--bg-2)"
                stroke={color}
                strokeOpacity={active ? 0.55 : 0.2}
              />
              <text x={n.x} y={n.y + 5} textAnchor="middle" fill="var(--text)" fontSize="12" fontFamily="var(--sans)">
                {n.title.length > 26 ? n.title.slice(0, 24) + "…" : n.title}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface WhyProps {
  telos: Telos;
  onOpenGoal: (g: Goal) => void;
  showIds: boolean;
}

type WhyMode = "columns" | "force";

export function Why({ telos, onOpenGoal, showIds }: WhyProps) {
  const [mode, setMode] = useState<WhyMode>("columns");
  const [hover, setHover] = useState<string | null>(null);
  return (
    <section className="why">
      <header className="band-head">
        <div>
          <h2 className="band-title">Goals, Challenges, Strategies</h2>
          <p className="band-sub">Hover anything. The related cards light up across the columns.</p>
        </div>
        <div className="seg">
          <button className={mode === "columns" ? "on" : ""} onClick={() => setMode("columns")} type="button">Columns</button>
          <button className={mode === "force" ? "on" : ""} onClick={() => setMode("force")} type="button">Graph</button>
        </div>
      </header>
      {mode === "columns" ? (
        <ColumnsView telos={telos} hover={hover} setHover={setHover} onOpenGoal={onOpenGoal} showIds={showIds} />
      ) : (
        <ForceView telos={telos} hover={hover} setHover={setHover} onOpenGoal={onOpenGoal} />
      )}
    </section>
  );
}
