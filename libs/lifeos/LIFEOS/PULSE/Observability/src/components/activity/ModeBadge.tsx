import type { SessionMode } from "@/types/algorithm";

const MODE_CONFIG: Record<SessionMode, { bg: string; border: string; text: string; label: string }> = {
  minimal: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    text: "text-amber-400",
    label: "MINIMAL",
  },
  native: {
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
    text: "text-blue-400",
    label: "NATIVE",
  },
  algorithm: {
    bg: "bg-purple-500/10",
    border: "border-purple-500/20",
    text: "text-purple-400",
    label: "ALGORITHM",
  },
};

const SIZE_CLASSES: Record<string, string> = {
  prominent: "h-7 px-3 text-sm font-medium rounded-md",
  compact: "h-6 px-2.5 text-xs font-medium rounded",
  micro: "h-5 px-2 text-xs rounded-sm",
};

interface ModeBadgeProps {
  mode: SessionMode;
  size: "prominent" | "compact" | "micro";
  showLabel?: boolean;
}

export default function ModeBadge({ mode, size, showLabel }: ModeBadgeProps) {
  const config = MODE_CONFIG[mode];
  const sizeClass = SIZE_CLASSES[size];
  const shouldShowLabel = showLabel ?? (size !== "micro");

  return (
    <span
      className={`inline-flex items-center gap-1 border shrink-0 ${config.bg} ${config.border} ${config.text} ${sizeClass}`}
    >
      {mode === "minimal" && (
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
      )}
      {mode === "native" && (
        <span className="w-2 h-2 rounded-full border border-blue-400 shrink-0" />
      )}
      {mode === "algorithm" && (
        <span className="relative w-2.5 h-2.5 shrink-0">
          <span className="absolute inset-0 rounded-full border border-purple-400/60" />
          <span className="absolute inset-[2px] rounded-full border border-purple-400/80" />
          <span className="absolute inset-[4px] rounded-full bg-purple-400" />
        </span>
      )}
      {shouldShowLabel && <span>{config.label}</span>}
    </span>
  );
}
