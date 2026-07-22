import { Terminal, RefreshCw, TrendingUp, Lightbulb, FastForward, Circle } from "lucide-react";
import { normalizeEffort } from "@/lib/effort";

const EFFORT_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  Standard: { bg: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-400" },
  Extended: { bg: "bg-orange-500/15", border: "border-orange-500/30", text: "text-orange-400" },
  Advanced: { bg: "bg-rose-500/15", border: "border-rose-500/30", text: "text-rose-400" },
  Deep: { bg: "bg-purple-500/15", border: "border-purple-500/30", text: "text-purple-400" },
  Comprehensive: { bg: "bg-red-500/15", border: "border-red-500/30", text: "text-red-400" },
};

interface ModeStyle {
  bg: string;
  border: string;
  text: string;
  label: string;
  Icon: typeof Terminal;
}

const MODE_STYLES: Record<string, ModeStyle> = {
  native: {
    bg: "bg-cyan-500/15",
    border: "border-cyan-500/30",
    text: "text-cyan-300",
    label: "NATIVE",
    Icon: Terminal,
  },
  minimal: {
    bg: "bg-amber-400/10",
    border: "border-amber-400/20",
    text: "text-amber-300",
    label: "MINIMAL",
    Icon: Circle,
  },
  loop: {
    bg: "bg-teal-500/15",
    border: "border-teal-500/30",
    text: "text-teal-300",
    label: "LOOP",
    Icon: RefreshCw,
  },
  optimize: {
    bg: "bg-emerald-500/15",
    border: "border-emerald-500/30",
    text: "text-emerald-300",
    label: "OPTIMIZE",
    Icon: TrendingUp,
  },
  ideate: {
    bg: "bg-violet-500/15",
    border: "border-violet-500/30",
    text: "text-violet-300",
    label: "IDEATE",
    Icon: Lightbulb,
  },
  "fast-path": {
    bg: "bg-lime-500/15",
    border: "border-lime-500/30",
    text: "text-lime-300",
    label: "FAST",
    Icon: FastForward,
  },
};

const SIZE_CLASSES = {
  compact: "h-6 px-2.5 text-xs",
  micro: "h-5 px-2 text-[10px]",
} as const;

interface OperationBadgeProps {
  mode?: string;
  effort?: string;
  size?: "compact" | "micro";
}

export default function OperationBadge({ mode, effort, size = "compact" }: OperationBadgeProps) {
  const sizeClass = SIZE_CLASSES[size];
  const baseClasses = `inline-flex items-center gap-1 font-bold uppercase tracking-widest border rounded shrink-0 ${sizeClass}`;
  const iconSize = size === "micro" ? "w-2.5 h-2.5" : "w-3 h-3";

  const modeKey = (mode || "").toLowerCase();
  const modeStyle = MODE_STYLES[modeKey];
  const normalized = normalizeEffort(effort);

  // Recognized sub-mode (native / minimal / loop / optimize / ideate / fast-path) wins —
  // these are operation-class tags, not tier tags.
  if (modeStyle) {
    const { Icon } = modeStyle;
    return (
      <span className={`${baseClasses} ${modeStyle.bg} ${modeStyle.border} ${modeStyle.text}`}>
        <Icon className={iconSize} strokeWidth={2.5} />
        {modeStyle.label}
      </span>
    );
  }

  // Otherwise: any session with a normalizable effort (algorithm, interactive, starting,
  // or any unrecognized mode that still carries a tier) renders the E-tier badge.
  if (normalized) {
    const style = EFFORT_STYLES[normalized.tierName];
    return (
      <span className={`${baseClasses} ${style.bg} ${style.border} ${style.text}`}>
        <span className="opacity-70">{normalized.eLevel}</span>
        {normalized.tierName.toUpperCase()}
      </span>
    );
  }

  return null;
}
