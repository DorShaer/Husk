"use client";

import type { CSSProperties } from "react";

// Minimal stroke icons — Lucide-style but hand-rolled so we don't need a CDN.
export interface IconProps {
  size?: number;
  stroke?: number;
  style?: CSSProperties;
}

interface IcoProps extends IconProps {
  d: string | string[];
}

function Ico({ d, size = 14, stroke = 1.6, style }: IcoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
         style={style} aria-hidden="true">
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  );
}

type IconFn = (p?: IconProps) => React.ReactElement;

function ico(d: string | string[], strokeOverride?: number): IconFn {
  return (p?: IconProps) => <Ico {...(p || {})} d={d} stroke={strokeOverride ?? p?.stroke} />;
}

export const Icons: Record<string, IconFn> = {
  Arrow:     ico("M5 12h14 M13 6l6 6-6 6"),
  ArrowUp:   ico("M12 19V5 M6 11l6-6 6 6"),
  ArrowDown: ico("M12 5v14 M18 13l-6 6-6-6"),
  ArrowFlat: ico("M5 12h14"),
  Dot:       ico("M12 12h.01", 3),
  X:         ico(["M18 6 6 18", "M6 6l12 12"]),
  Chev:      ico("M6 9l6 6 6-6"),
  ChevR:     ico("M9 18l6-6-6-6"),
  Plus:      ico(["M12 5v14", "M5 12h14"]),
  Spark:     ico("M12 2l2.2 5.8L20 10l-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-2.2z"),
  Target:    ico(["M12 22a10 10 0 100-20 10 10 0 000 20z", "M12 18a6 6 0 100-12 6 6 0 000 12z", "M12 14a2 2 0 100-4 2 2 0 000 4z"]),
  Warn:      ico(["M12 9v4", "M12 17h.01", "M10.29 3.86 1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"]),
  Link:      ico(["M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"]),
  Pause:     ico(["M6 4v16", "M18 4v16"]),
  Play:      ico("M6 4l14 8-14 8V4z"),
  Cog:       ico(["M12 15a3 3 0 100-6 3 3 0 000 6z", "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"]),
  Filter:    ico("M22 3H2l8 9.46V19l4 2v-8.54z"),
  Flag:      ico(["M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z", "M4 22V15"]),
  Grid:      ico(["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"]),
  Flow:      ico(["M5 3v6", "M19 15v6", "M12 3v18", "M5 9a3 3 0 100 6 3 3 0 000-6z", "M19 9a3 3 0 100 6 3 3 0 000-6z"]),
  Eye:       ico(["M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z", "M12 15a3 3 0 100-6 3 3 0 000 6z"]),
  Clock:     ico(["M12 22a10 10 0 100-20 10 10 0 000 20z", "M12 6v6l4 2"]),
  Check:     ico("M20 6 9 17l-5-5"),
};
