export const SCHEMA_VERSION = "1.0.0";

export const colors = {
  light: {
    bg: "#FAFAF7",
    bgElevated: "#FFFFFF",
    bgSubtle: "#F1F0EA",
    border: "#E5E3DA",
    text: "#1B1B18",
    textMuted: "#6F6E66",
    accent: "#1F6FEB",
    accentHover: "#1858C4",
    success: "#2D9D6F",
    warn: "#C68B17",
    error: "#C0392B",
    pillTemplate: "#C68B17",
    pillCustomized: "#2D9D6F",
  },
  dark: {
    bg: "#0E0E0C",
    bgElevated: "#171715",
    bgSubtle: "#1F1E1B",
    border: "#2A2924",
    text: "#F2F1EA",
    textMuted: "#8A8980",
    accent: "#5A8FFF",
    accentHover: "#7CA8FF",
    success: "#4BC189",
    warn: "#E0A938",
    error: "#E66B5C",
    pillTemplate: "#E0A938",
    pillCustomized: "#4BC189",
  },
} as const;

export const type = {
  fontSans: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontMono: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  fontSerif: '"Iowan Old Style", "Source Serif Pro", Georgia, serif',
  scale: {
    xs: "12px",
    sm: "14px",
    base: "16px",
    md: "18px",
    lg: "22px",
    xl: "28px",
    xxl: "36px",
    display: "48px",
  },
  weight: { normal: 400, medium: 500, semibold: 600, bold: 700 },
  lineHeight: { tight: 1.2, snug: 1.35, normal: 1.55, loose: 1.75 },
} as const;

export const space = {
  px: "1px",
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
  xxl: "32px",
  xxxl: "48px",
} as const;

export const radius = {
  sm: "4px",
  md: "8px",
  lg: "12px",
  pill: "999px",
} as const;

export const motion = {
  fast: "120ms cubic-bezier(0.4, 0, 0.2, 1)",
  base: "200ms cubic-bezier(0.4, 0, 0.2, 1)",
  slow: "320ms cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

export const layout = {
  sidebarWidth: "240px",
  headerHeight: "56px",
  contentMaxWidth: "880px",
} as const;

export type Mode = "light" | "dark";

export function cssVars(mode: Mode): string {
  const c = colors[mode];
  return Object.entries(c).map(([k, v]) => `--c-${k}: ${v};`).join(" ");
}
