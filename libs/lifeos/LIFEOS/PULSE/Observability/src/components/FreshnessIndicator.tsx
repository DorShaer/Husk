"use client";
import { useState } from "react";
import { Clock, AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";

export interface FreshnessFile {
  name: string;
  date: string | null;
  source: "state" | "content" | "filename" | "mtime" | "unknown";
}
export interface FreshnessData {
  dataDate: string | null;
  label: string;
  daysOld: number | null;
  tier: "fresh" | "aging" | "stale" | "unknown";
  perFile: FreshnessFile[];
}

function formatAge(daysOld: number | null): string {
  if (daysOld == null) return "—";
  if (daysOld < 1) return "today";
  if (daysOld < 2) return "1 day old";
  if (daysOld < 60) return `${daysOld} days old`;
  const months = Math.round(daysOld / 30);
  if (months < 12) return `${months} mo old`;
  const years = (daysOld / 365).toFixed(1);
  return `${years} yr old`;
}

const TIER_STYLE: Record<FreshnessData["tier"], { dot: string; text: string; border: string; bg: string; Icon: any; label: string }> = {
  fresh:   { dot: "bg-ok",    text: "text-ok",    border: "border-[rgba(74,222,128,0.25)]",  bg: "bg-[rgba(74,222,128,0.1)]",  Icon: CheckCircle2,   label: "Fresh" },
  aging:   { dot: "bg-warn",  text: "text-warn",  border: "border-[rgba(251,191,36,0.25)]",  bg: "bg-[rgba(251,191,36,0.1)]",  Icon: Clock,          label: "Aging" },
  stale:   { dot: "bg-err",   text: "text-err",   border: "border-[rgba(248,113,113,0.25)]", bg: "bg-[rgba(248,113,113,0.1)]", Icon: AlertTriangle,  label: "Stale" },
  unknown: { dot: "bg-ink-3", text: "text-ink-2", border: "border-line-2",                   bg: "bg-surface-3",               Icon: HelpCircle,     label: "Unknown" },
};

export function FreshnessIndicator({
  freshness,
  className = "",
  compact = false,
}: {
  freshness: FreshnessData | null | undefined;
  className?: string;
  /** Drop the `· N of M sources dated` inline label so the pill stays narrow
   *  when mounted in chrome. Hover tooltip still shows full per-source list. */
  compact?: boolean;
}) {
  const [hover, setHover] = useState(false);
  if (!freshness) {
    return (
      <div className={`inline-flex items-center gap-1.5 text-xs text-ink-3 ${className}`}>
        <HelpCircle className="w-3 h-3" /> No date info
      </div>
    );
  }
  const style = TIER_STYLE[freshness.tier];
  const Icon = style.Icon;
  const dated = freshness.perFile.filter(f => f.date);
  const undated = freshness.perFile.filter(f => !f.date);
  const sorted = [...dated].sort((a, b) => (a.date! < b.date! ? -1 : 1));
  const top = sorted.slice(0, 6);

  return (
    <div
      className={`relative inline-block ${className}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full border ${style.border} ${style.bg} cursor-default whitespace-nowrap`}
        aria-label={`Data freshness: ${style.label} — ${formatAge(freshness.daysOld)}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
        <Icon className={`w-3.5 h-3.5 ${style.text}`} />
        <span className={`text-[11px] font-bold uppercase tracking-wider ${style.text}`}>
          {style.label}
        </span>
        <span className={`text-[11px] ${style.text} opacity-80`}>· {formatAge(freshness.daysOld)}</span>
        {!compact && freshness.label && freshness.label !== "No date info" && (
          <span className="text-[11px] text-ink-2">· {freshness.label}</span>
        )}
      </div>

      {hover && dated.length > 0 && (
        <div className="absolute right-0 top-full mt-2 z-50 w-72 rounded-lg border border-line-2 bg-surface-1 backdrop-blur-sm shadow-xl p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-2 mb-2">
            Data sources
          </div>
          <div className="flex flex-col gap-1">
            {top.map((f) => (
              <div key={f.name} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-ink-2 truncate">{f.name}</span>
                <span className="text-ink-3 tabular-nums shrink-0">{f.date}</span>
              </div>
            ))}
          </div>
          {undated.length > 0 && (
            <div className="mt-2 pt-2 border-t border-line-1 text-[11px] text-ink-3">
              {undated.length} file{undated.length === 1 ? "" : "s"} without a date
            </div>
          )}
        </div>
      )}
    </div>
  );
}
