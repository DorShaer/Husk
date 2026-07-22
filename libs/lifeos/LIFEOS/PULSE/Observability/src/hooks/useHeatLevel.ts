"use client";

import { useMemo } from "react";

// ─── Heat Color Scale (Tokyo Night) ───

const HEAT_COLORS = {
  cold: "#565f89",
  cool: "#7aa2f7",
  warm: "#9d7cd8",
  hot: "#e0af68",
  fire: "#f7768e",
  inferno: "#ff5555",
};

const HEAT_THRESHOLDS = [4, 8, 16, 32, 64, 128];

const COLOR_ARRAY = [
  HEAT_COLORS.cold,
  HEAT_COLORS.cool,
  HEAT_COLORS.warm,
  HEAT_COLORS.hot,
  HEAT_COLORS.fire,
  HEAT_COLORS.inferno,
];

// ─── Color Utilities ───

function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = x.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
  );
}

function interpolateColor(c1: string, c2: string, factor: number): string {
  const a = hexToRgb(c1);
  const b = hexToRgb(c2);
  return rgbToHex(
    Math.round(a.r + (b.r - a.r) * factor),
    Math.round(a.g + (b.g - a.g) * factor),
    Math.round(a.b + (b.b - a.b) * factor)
  );
}

function getHeatIndex(epm: number): number {
  for (let i = 0; i < HEAT_THRESHOLDS.length; i++) {
    if (epm < HEAT_THRESHOLDS[i]) return i;
  }
  return HEAT_THRESHOLDS.length;
}

// ─── Hook ───

export function useHeatLevel(eventsPerMinute: number, activeAgentCount: number) {
  return useMemo(() => {
    // Events contribution (logarithmic)
    const eventsContribution =
      eventsPerMinute <= 0 ? 0 : eventsPerMinute >= 128 ? 1 : Math.log2(Math.max(1, eventsPerMinute)) / Math.log2(128);

    // Agents contribution (linear, 1-5 range)
    const agentsContribution =
      activeAgentCount <= 1 ? 0 : activeAgentCount >= 5 ? 1 : (activeAgentCount - 1) / 4;

    // Combined (85% events, 15% agents)
    const intensity = Math.min(1, Math.max(0, eventsContribution * 0.85 + agentsContribution * 0.15));

    // Color interpolation
    const idx = getHeatIndex(eventsPerMinute);
    let color: string;
    if (idx === 0) {
      color = interpolateColor(HEAT_COLORS.cold, HEAT_COLORS.cool, eventsPerMinute / HEAT_THRESHOLDS[0]);
    } else if (idx >= COLOR_ARRAY.length) {
      color = HEAT_COLORS.inferno;
    } else {
      const lower = HEAT_THRESHOLDS[idx - 1];
      const upper = HEAT_THRESHOLDS[idx];
      color = interpolateColor(COLOR_ARRAY[idx - 1], COLOR_ARRAY[idx], (eventsPerMinute - lower) / (upper - lower));
    }

    // Label
    let label: string;
    if (eventsPerMinute < 4) label = "Cold";
    else if (eventsPerMinute < 8) label = "Cool";
    else if (eventsPerMinute < 16) label = "Warm";
    else if (eventsPerMinute < 32) label = "Hot";
    else if (eventsPerMinute < 64) label = "Fire";
    else label = "Inferno";

    return { intensity, color, label };
  }, [eventsPerMinute, activeAgentCount]);
}
