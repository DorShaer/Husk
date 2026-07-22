import { normalizeEffort } from "@/lib/effort";

const STYLES: Record<string, { bg: string; border: string; text: string }> = {
  Standard: { bg: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-400" },
  Extended: { bg: "bg-orange-500/15", border: "border-orange-500/30", text: "text-orange-400" },
  Advanced: { bg: "bg-rose-500/15", border: "border-rose-500/30", text: "text-rose-400" },
  Deep: { bg: "bg-purple-500/15", border: "border-purple-500/30", text: "text-purple-400" },
  Comprehensive: { bg: "bg-red-500/15", border: "border-red-500/30", text: "text-red-400" },
};

interface EffortBadgeProps {
  effort: string;
}

export default function EffortBadge({ effort }: EffortBadgeProps) {
  const normalized = normalizeEffort(effort);
  if (!normalized) return null;
  const style = STYLES[normalized.tierName];

  return (
    <span
      className={`inline-flex items-center gap-1 h-6 px-2.5 text-xs font-bold uppercase tracking-widest border rounded shrink-0 ${style.bg} ${style.border} ${style.text}`}
    >
      <span className="opacity-70">{normalized.eLevel}</span>
      {normalized.tierName.toUpperCase()}
    </span>
  );
}
