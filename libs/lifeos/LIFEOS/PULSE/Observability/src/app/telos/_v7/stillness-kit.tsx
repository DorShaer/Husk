"use client";

// Stillness Kit — small contemplative widget for the top-right of a tab.
//
// Universal: reads ONLY from the user's TELOS schema (owner streak, snapshot
// metrics). No hardcoded names, dimensions, or quotes.
//
// The "stillness" framing — pulse + presence + the day's centering thought —
// gives the user a calm reference point amid the analytical density of the
// dashboard. Intentionally low-data; this is not another chart.
//
// The widget is positioned by its parent (Hero or any future tab adopting it).
// All values come from `Telos` — when fields are empty, the widget gracefully
// hides the affected line.

import type { Telos, SnapshotMetric } from "./data";

interface StillnessKitProps {
  telos: Telos;
}

// Pure, deterministic centering prompt selected from the TELOS preferences
// (aphorisms array). When empty, falls back to a neutral pulse line. The
// selection is index-stable for a given install — same content surface on
// every render until the underlying data changes.
function pickCenteringLine(telos: Telos): string | null {
  const aphorisms = telos.preferences.aphorisms ?? [];
  if (aphorisms.length === 0) return null;
  // Deterministic pick: index = sum of dimension IDs mod length. Same TELOS
  // shape ⇒ same pick. No Date.now / Math.random.
  const sum = telos.dimensions.reduce((acc, d) => acc + d.id.length + Math.round(d.cur), 0);
  const idx = aphorisms.length === 0 ? 0 : sum % aphorisms.length;
  return aphorisms[idx] ?? null;
}

function formatLabel(s: SnapshotMetric): string {
  // Scale-aware label: 0–10 stat shows as "7/10"; 0–1 shows percent-like.
  if (s.of === 10) return `${s.v.toFixed(1)}/10`;
  if (s.of === 1) return `${Math.round(s.v * 100)}%`;
  if (s.of) return `${s.v.toFixed(0)}/${s.of}`;
  return s.v.toString();
}

function colorFor(metricId: string): string {
  // Maps metric IDs to dimension CSS vars. Each metric color is purely a
  // visual dot — no semantic mapping to specific user dimensions.
  // Falls back to --text-2 for unknown IDs.
  const map: Record<string, string> = {
    mood: "--freedom",
    energy: "--money",
    focus: "--creative",
    presence: "--health",
    calm: "--rhythms",
  };
  return map[metricId] ?? "--text-2";
}

export function StillnessKit({ telos }: StillnessKitProps) {
  const { owner, snapshot } = telos;
  const hasStreak = owner.streak > 0;
  const hasSnapshot = snapshot.length > 0;
  const centering = pickCenteringLine(telos);

  // Empty kit — render nothing rather than a blank shell.
  if (!hasStreak && !hasSnapshot && !centering) return null;

  return (
    <aside className="stillness-kit" aria-label="stillness kit">
      <div className="stillness-kit-pulse" aria-hidden="true">
        <span className="stillness-kit-dot" />
        <span className="stillness-kit-ring" />
      </div>

      <div className="stillness-kit-body">
        {hasStreak && (
          <div className="stillness-kit-row">
            <span className="stillness-kit-label">Streak</span>
            <span className="stillness-kit-value mono">{owner.streak}d</span>
          </div>
        )}

        {hasSnapshot && (
          <div className="stillness-kit-snap">
            {snapshot.map((s) => (
              <span key={s.id} className="stillness-kit-snap-item" title={`${s.label}`}>
                <span className="stillness-kit-snap-dot" style={{ background: `var(${colorFor(s.id)})` }} />
                <span className="stillness-kit-snap-label">{s.label.toLowerCase()}</span>
                <span className="stillness-kit-snap-value mono">{formatLabel(s)}</span>
              </span>
            ))}
          </div>
        )}

        {centering && (
          <p className="stillness-kit-centering">{centering}</p>
        )}
      </div>
    </aside>
  );
}
