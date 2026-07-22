interface FocusIndicatorProps {
  focus: number;
}

export default function FocusIndicator({ focus }: FocusIndicatorProps) {
  const pct = Math.max(0, Math.min(1, focus)) * 100;

  return (
    <div className="flex items-center gap-2 min-w-[140px]">
      <span className="text-[13px] text-violet-400 font-medium shrink-0 w-8">Dream</span>
      <div className="relative flex-1 h-1.5 rounded-full overflow-hidden bg-white/[0.05]">
        {/* Gradient track */}
        <div
          className="absolute inset-0 rounded-full"
          style={{ background: "linear-gradient(to right, #8b5cf6, #6366f1, #3b82f6, #f59e0b, #ef4444)" }}
        />
        {/* Dot marker */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white border-2 border-line-1 shadow-sm shadow-white/20"
          style={{ left: `calc(${pct}% - 5px)` }}
        />
      </div>
      <span className="text-[13px] text-red-400 font-medium shrink-0 w-7 text-right">Laser</span>
    </div>
  );
}
