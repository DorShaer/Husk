"use client";

import type { Dimension } from "./data";

// Universal dimension visualization — replaces the ring grid.
//
// Each dimension renders as a horizontal row:
//   [label] [filled bar = cur] [gap = ideal-cur, dotted] [ideal marker] [numbers] [velo arrow]
//
// The GAP is the visual headline, not the fill. Most life dashboards
// celebrate what's done; this one shows what's left, because the gap is
// what the user actually has to act on.
//
// Universality: works for any N dimensions, any labels, any cur/ideal/velo
// values. No hardcoded dim IDs or counts. Color comes from the dim's own
// `color` field (CSS var name like '--health').

interface DimensionBarsProps {
  dimensions: readonly Dimension[];
  onDimClick?: (id: string) => void;
}

interface DimensionBarRowProps {
  d: Dimension;
  onClick?: () => void;
}

function veloMark(velo: number): { glyph: string; cls: string; pct: number } {
  if (velo > 0.15) return { glyph: "↗", cls: "up", pct: Math.min(100, Math.abs(velo) * 20) };
  if (velo < -0.15) return { glyph: "↘", cls: "down", pct: Math.min(100, Math.abs(velo) * 20) };
  return { glyph: "·", cls: "flat", pct: 0 };
}

function fmtDelta(velo: number): string {
  if (Math.abs(velo) < 0.05) return "steady";
  const sign = velo > 0 ? "+" : "";
  // Trim trailing zeros; show one decimal max for compactness.
  return `${sign}${velo.toFixed(1).replace(/\.0$/, "")}`;
}

function DimensionBarRow({ d, onClick }: DimensionBarRowProps) {
  const cur = Math.max(0, Math.min(100, d.cur));
  const ideal = Math.max(0, Math.min(100, d.ideal));
  const curPct = (cur / 100) * 100;
  const idealPct = (ideal / 100) * 100;
  const v = veloMark(d.velo);

  return (
    <div
      className="dim-bar-row"
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); } : undefined}
    >
      <div className="dim-bar-label">{d.label}</div>

      <div className="dim-bar-track" aria-label={`${d.label}: ${Math.round(cur)} of ${Math.round(ideal)}, velocity ${d.velo}`}>
        {/* The full track represents 100. Ideal marker is a vertical line. */}
        <div className="dim-bar-fill" style={{ width: `${curPct}%`, background: `var(${d.color})` }}>
          <div className="dim-bar-leading-edge" style={{ background: `var(${d.color})` }} />
        </div>
        <div className="dim-bar-gap" style={{ left: `${curPct}%`, width: `${Math.max(0, idealPct - curPct)}%` }} />
        <div className="dim-bar-ideal-mark" style={{ left: `${idealPct}%`, borderColor: `var(${d.color})` }} />
      </div>

      <div className="dim-bar-numbers">
        <span className="dim-bar-cur mono">{Math.round(cur)}</span>
        <span className="dim-bar-sep">/</span>
        <span className="dim-bar-ideal mono">{Math.round(ideal)}</span>
      </div>

      <div className={`dim-bar-velo ${v.cls}`} title={`velocity ${d.velo}`}>
        <span className="dim-bar-velo-glyph">{v.glyph}</span>
        <span className="dim-bar-velo-num mono">{fmtDelta(d.velo)}</span>
      </div>
    </div>
  );
}

export function DimensionBars({ dimensions, onDimClick }: DimensionBarsProps) {
  if (dimensions.length === 0) {
    return (
      <div className="dim-bars-empty">
        No life-area dimensions populated yet. Run <code>/interview ideal-state</code> or drop files into <code>LIFEOS/USER/TELOS/IDEAL_STATE/</code>.
      </div>
    );
  }

  // Aggregate composite — average current across all dims.
  const avg = dimensions.reduce((a, d) => a + d.cur, 0) / dimensions.length;
  const idealAvg = dimensions.reduce((a, d) => a + d.ideal, 0) / dimensions.length;
  const compositeGap = idealAvg - avg;

  return (
    <div className="dim-bars">
      <div className="dim-bars-header">
        <span className="dim-bars-title">Life Dimensions</span>
        <span className="dim-bars-aggregate">
          <span className="mono">{Math.round(avg)}</span>
          <span className="dim-bars-sep">of</span>
          <span className="mono">{Math.round(idealAvg)}</span>
          <span className="dim-bars-sep">·</span>
          <span className="mono dim-bars-gap">{compositeGap > 0 ? `${Math.round(compositeGap)} to go` : "at ideal"}</span>
        </span>
      </div>
      <div className="dim-bars-list">
        {dimensions.map((d) => (
          <DimensionBarRow key={d.id} d={d} onClick={onDimClick ? () => onDimClick(d.id) : undefined} />
        ))}
      </div>
    </div>
  );
}
