const IDEATION_PRESETS: Record<string, { bg: string; border: string; text: string }> = {
  dream:              { bg: "bg-violet-500/15", border: "border-violet-500/30", text: "text-violet-400" },
  explore:            { bg: "bg-blue-500/15",   border: "border-blue-500/30",   text: "text-blue-400" },
  balanced:           { bg: "bg-[rgba(168,165,200,0.15)]",   border: "border-[rgba(168,165,200,0.3)]",   text: "text-ink-2" },
  directed:           { bg: "bg-amber-500/15",  border: "border-amber-500/30",  text: "text-amber-400" },
  surgical:           { bg: "bg-red-500/15",    border: "border-red-500/30",    text: "text-red-400" },
  "wild-but-picky":   { bg: "bg-fuchsia-500/15", border: "border-fuchsia-500/30", text: "text-fuchsia-400" },
  "focused-but-diverse": { bg: "bg-teal-500/15", border: "border-teal-500/30", text: "text-teal-400" },
};

const OPTIMIZE_PRESETS: Record<string, { bg: string; border: string; text: string }> = {
  cautious:            { bg: "bg-emerald-500/15", border: "border-emerald-500/30", text: "text-emerald-400" },
  "standard-optimize": { bg: "bg-[rgba(168,165,200,0.15)]",   border: "border-[rgba(168,165,200,0.3)]",   text: "text-ink-2" },
  aggressive:          { bg: "bg-orange-500/15",  border: "border-orange-500/30",  text: "text-orange-400" },
};

const CUSTOM_STYLE = { bg: "bg-[rgba(168,165,200,0.1)]", border: "border-[rgba(168,165,200,0.2)]", text: "text-ink-3" };

interface PresetBadgeProps {
  preset: string | null;
  mode?: string;
}

export default function PresetBadge({ preset, mode }: PresetBadgeProps) {
  const key = preset?.toLowerCase() ?? "";
  const presets = mode === "optimize" ? OPTIMIZE_PRESETS : IDEATION_PRESETS;
  const config = presets[key] ?? (key ? { ...CUSTOM_STYLE } : null);

  if (!config) {
    return (
      <span className={`inline-flex items-center h-5 px-2 text-[13px] font-medium uppercase tracking-wider border rounded-full shrink-0 ${CUSTOM_STYLE.bg} ${CUSTOM_STYLE.border} ${CUSTOM_STYLE.text}`}>
        Custom
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center h-5 px-2 text-[13px] font-medium uppercase tracking-wider border rounded-full shrink-0 ${config.bg} ${config.border} ${config.text}`}>
      {preset}
    </span>
  );
}
