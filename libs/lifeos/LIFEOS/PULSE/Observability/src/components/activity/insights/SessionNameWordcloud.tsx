"use client";

import { useState, useMemo } from "react";
import { useSessionNames } from "@/hooks/useObservabilityData";

/**
 * Widget 12: SessionNameWordcloud
 *
 * Tag cloud layout: words arranged in a flowing flex container,
 * sized by frequency. Colors rotate through a palette.
 * No external libraries.
 */

// ─── Constants ───

const WORD_COLORS = [
  "#60a5fa", // blue-400
  "#c084fc", // purple-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#22d3ee", // cyan-400
  "#fb7185", // rose-400
];

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 48;
const MAX_WORDS = 40;
const MIN_WORDS_FOR_CLOUD = 5;

// ─── Types ───

interface WordEntry {
  word: string;
  count: number;
  fontSize: number;
  color: string;
  fontWeight: "bold" | "normal";
  opacity: number;
}

interface SessionNamesData {
  names?: Record<string, string>;
  wordFrequency?: Record<string, number>;
  sessions?: Array<Record<string, unknown>>;
}

// ─── Helpers ───

function extractWordFrequencies(data: SessionNamesData): {
  wordFreq: Map<string, number>;
  allNames: string[];
} {
  const allNames: string[] = [];
  let wordFreq = new Map<string, number>();

  // If the API provides pre-computed wordFrequency, use it
  if (data.wordFrequency && Object.keys(data.wordFrequency).length > 0) {
    for (const [word, count] of Object.entries(data.wordFrequency)) {
      if (word.length > 1) {
        wordFreq.set(word, count);
      }
    }
  }

  // Collect all session names for tooltip lookups
  if (data.names && typeof data.names === "object") {
    for (const name of Object.values(data.names)) {
      if (typeof name === "string") allNames.push(name);
    }
  }

  // If sessions array exists, also extract names from it
  if (data.sessions && Array.isArray(data.sessions)) {
    for (const session of data.sessions) {
      const name = (session.name ?? session.sessionName ?? session.taskDescription ?? "") as string;
      if (name) allNames.push(name);
    }
  }

  // If no pre-computed word frequency, compute from session names
  if (wordFreq.size === 0 && allNames.length > 0) {
    const freq = new Map<string, number>();
    for (const name of allNames) {
      const words = name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .split(/[\s-]+/)
        .filter((w) => w.length > 1);
      for (const word of words) {
        freq.set(word, (freq.get(word) ?? 0) + 1);
      }
    }
    wordFreq = freq;
  }

  return { wordFreq, allNames };
}

function buildWordEntries(wordFreq: Map<string, number>): WordEntry[] {
  // Sort by count descending, take top N
  const sorted = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_WORDS);

  if (sorted.length === 0) return [];

  const counts = sorted.map(([, c]) => c);
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  const countRange = maxCount - minCount || 1;

  // Median for bold threshold
  const sortedCounts = [...counts].sort((a, b) => a - b);
  const median = sortedCounts[Math.floor(sortedCounts.length / 2)];

  return sorted.map(([word, count], index) => {
    const normalized = (count - minCount) / countRange;
    const fontSize = MIN_FONT_SIZE + normalized * (MAX_FONT_SIZE - MIN_FONT_SIZE);
    const opacity = 0.5 + normalized * 0.5;
    const color = WORD_COLORS[index % WORD_COLORS.length];
    const fontWeight: "bold" | "normal" = count > median ? "bold" : "normal";

    return { word, count, fontSize, color, fontWeight, opacity };
  });
}

function findSessionsContaining(
  word: string,
  allNames: string[],
  limit: number = 5
): string[] {
  const lower = word.toLowerCase();
  const matches: string[] = [];
  for (const name of allNames) {
    if (name.toLowerCase().includes(lower)) {
      matches.push(name);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

// ─── Component ───

export default function SessionNameWordcloud() {
  const { data, isLoading, error } = useSessionNames();
  const [hoveredWord, setHoveredWord] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });

  const processed = useMemo(() => {
    if (!data) return null;
    const { wordFreq, allNames } = extractWordFrequencies(data as SessionNamesData);
    const entries = buildWordEntries(wordFreq);
    return { entries, allNames, totalSessions: allNames.length };
  }, [data]);

  const hoveredEntry = useMemo(() => {
    if (!hoveredWord || !processed) return null;
    return processed.entries.find((e) => e.word === hoveredWord) ?? null;
  }, [hoveredWord, processed]);

  const hoveredSessions = useMemo(() => {
    if (!hoveredWord || !processed) return [];
    return findSessionsContaining(hoveredWord, processed.allNames);
  }, [hoveredWord, processed]);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Session Names
        </h3>
        <div className="flex flex-wrap items-center justify-center gap-3 py-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-5 rounded bg-surface-2 animate-pulse"
              style={{ width: 40 + Math.random() * 60 }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Session Names
        </h3>
        <p className="text-xs text-rose-400">Failed to load: {error}</p>
      </div>
    );
  }

  if (!processed || processed.entries.length === 0) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Session Names
        </h3>
        <p className="text-xs text-ink-3">No session name data available</p>
      </div>
    );
  }

  // Sparse data: show simple list instead of cloud
  if (processed.entries.length < MIN_WORDS_FOR_CLOUD) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Session Names
        </h3>
        <p className="text-[14px] text-ink-3 mb-3">
          Top words from {processed.totalSessions} session{processed.totalSessions !== 1 ? "s" : ""}
        </p>
        <div className="space-y-1.5">
          {processed.entries.map((entry) => (
            <div key={entry.word} className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-sm text-ink-1">{entry.word}</span>
              <span className="text-xs text-ink-3 font-mono tabular-nums">
                {entry.count}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider">
          Session Names
        </h3>
        <span className="text-[14px] text-ink-3 font-mono tabular-nums">
          Top words from {processed.totalSessions} session{processed.totalSessions !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="relative flex flex-wrap items-center justify-center gap-x-3 gap-y-2 p-4">
        {processed.entries.map((entry) => (
          <span
            key={entry.word}
            className="cursor-pointer transition-transform duration-150 hover:scale-110 select-none"
            style={{
              fontSize: `${entry.fontSize}px`,
              color: entry.color,
              fontWeight: entry.fontWeight,
              opacity: hoveredWord && hoveredWord !== entry.word ? 0.3 : entry.opacity,
              lineHeight: 1.2,
            }}
            onMouseEnter={(e) => {
              setHoveredWord(entry.word);
              const rect = (e.target as HTMLElement).getBoundingClientRect();
              const parentRect = (e.target as HTMLElement)
                .closest(".relative")
                ?.getBoundingClientRect();
              if (parentRect) {
                setTooltipPos({
                  x: rect.left - parentRect.left + rect.width / 2,
                  y: rect.top - parentRect.top,
                });
              }
            }}
            onMouseLeave={() => setHoveredWord(null)}
          >
            {entry.word}
          </span>
        ))}

        {/* Tooltip */}
        {hoveredWord && hoveredEntry && (
          <div
            className="absolute z-50 px-2.5 py-2 rounded-md bg-surface-2 border border-white/[0.08] shadow-lg pointer-events-none max-w-[240px]"
            style={{
              left: tooltipPos.x,
              top: tooltipPos.y - 8,
              transform: "translate(-50%, -100%)",
            }}
          >
            <p className="text-xs text-ink-1 font-medium">
              {hoveredEntry.word}:{" "}
              <span className="font-mono tabular-nums">
                {hoveredEntry.count}
              </span>{" "}
              occurrence{hoveredEntry.count !== 1 ? "s" : ""}
            </p>
            {hoveredSessions.length > 0 && (
              <div className="mt-1.5 space-y-0.5">
                {hoveredSessions.map((name, i) => (
                  <p
                    key={i}
                    className="text-[13px] text-ink-3 truncate"
                  >
                    {name}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
