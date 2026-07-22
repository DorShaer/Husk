"use client";

import { useEffect, useState } from "react";
import { Sparkles, ArrowRight, Flame, Zap } from "lucide-react";

interface LifeCardData {
  oneSentence: string;
  current: {
    focus: string;
    energy: string;
    mood: string;
    topIntent: string;
  };
  nextActions: string[];
  sparks: string[];
  timelineBlockCount: number;
  files: {
    sparks: boolean;
    timeline: boolean;
    current: boolean;
  };
}

export default function LifeCard() {
  const [data, setData] = useState<LifeCardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/observability/life-card")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] p-6">
        <p className="text-err text-sm">Life Card unavailable: {error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-line-1 bg-surface-2 p-6 animate-pulse">
        <div className="h-6 bg-surface-3 rounded w-3/4 mb-4" />
        <div className="h-4 bg-surface-3 rounded w-1/2" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line-2 bg-gradient-to-br from-surface-2 to-surface-1 p-6 space-y-5">
      {/* One Sentence */}
      <div>
        <p className="text-xl text-ink-1 font-serif leading-relaxed">
          {data.oneSentence}
        </p>
        <p className="text-xs text-ink-3 mt-1">
          Top intent: {data.current.topIntent}
        </p>
      </div>

      {/* Next Actions */}
      {data.nextActions.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-2">
            Next Moves
          </h3>
          <ul className="space-y-1.5">
            {data.nextActions.map((action, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm text-ink-2"
              >
                <ArrowRight className="w-3.5 h-3.5 mt-0.5 text-blue-400 shrink-0" />
                {action}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sparks + 2036 Stats */}
      <div className="flex gap-4 pt-2 border-t border-line-1">
        {data.sparks.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-ink-2">
            <Flame className="w-3.5 h-3.5 text-orange-400" />
            <span>
              {data.sparks.length} sparks:{" "}
              {data.sparks.slice(0, 3).join(", ")}
              {data.sparks.length > 3 && ` +${data.sparks.length - 3}`}
            </span>
          </div>
        )}
        {data.timelineBlockCount > 0 && (
          <div className="flex items-center gap-2 text-xs text-ink-2">
            <Sparkles className="w-3.5 h-3.5 text-purple-400" />
            <span>{data.timelineBlockCount} 2036 moments</span>
          </div>
        )}
      </div>

      {/* File Status */}
      <div className="flex gap-3 text-xs text-ink-3">
        {Object.entries(data.files).map(([name, exists]) => (
          <span key={name} className="flex items-center gap-1">
            <Zap
              className={`w-3 h-3 ${
                exists ? "text-ok" : "text-ink-3"
              }`}
            />
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}
