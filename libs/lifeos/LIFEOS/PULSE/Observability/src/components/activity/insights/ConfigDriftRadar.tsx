"use client";

import { useState, useMemo } from "react";
import { useConfigChanges } from "@/hooks/useObservabilityData";

/**
 * Widget 8: ConfigDriftRadar
 *
 * SVG radar/spider chart showing config change frequency by domain.
 * Domains extracted from config_path in change events.
 * No external charting libraries.
 */

interface DomainCount {
  domain: string;
  count: number;
}

function extractDomains(
  events: Array<Record<string, unknown>>
): DomainCount[] {
  const counts = new Map<string, number>();

  for (const event of events) {
    const configPath =
      (event.config_path as string) ??
      (event.file as string) ??
      (event.path as string) ??
      "";

    if (!configPath) continue;

    // Extract domain from path: first meaningful segment
    // e.g., "settings.json" -> "settings", "hooks/PRDSync.hook.ts" -> "hooks"
    // "MEMORY/STATE/work.json" -> "MEMORY", "LIFEOS/ALGORITHM/v3.8.0.md" -> "LifeOS"
    const segments = configPath.replace(/^[./~]+/, "").split("/");
    let domain = segments[0] || "other";

    // Clean up common patterns
    if (domain.includes(".")) {
      // File at root level: "settings.json" -> "settings"
      domain = domain.replace(/\.[^.]+$/, "");
    }

    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count);
}

function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleRad: number
): { x: number; y: number } {
  return {
    x: cx + r * Math.cos(angleRad),
    y: cy + r * Math.sin(angleRad),
  };
}

function buildPolygonPoints(
  cx: number,
  cy: number,
  r: number,
  sides: number
): string {
  const points: string[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
    const { x, y } = polarToCartesian(cx, cy, r, angle);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(" ");
}

function StabilityScore({
  total,
  cx,
  cy,
}: {
  total: number;
  cx: number;
  cy: number;
}) {
  // Stability: inverse of changes. More changes = less stable.
  // Scale: 0 changes = 100%, 50+ changes = 0%
  const stability = Math.max(0, Math.min(100, Math.round(100 - total * 2)));
  const color =
    stability > 80
      ? "#34d399" // emerald-400
      : stability >= 50
        ? "#fbbf24" // amber-400
        : "#fb7185"; // rose-400

  return (
    <g>
      <text
        x={cx}
        y={cy - 6}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={18}
        fontWeight={600}
        fill={color}
      >
        {stability}%
      </text>
      <text
        x={cx}
        y={cy + 12}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={9}
        fill="var(--ink-3)"
      >
        Stability
      </text>
    </g>
  );
}

function BarFallback({ domains }: { domains: DomainCount[] }) {
  const max = domains.reduce((m, d) => Math.max(m, d.count), 1);

  return (
    <div className="space-y-2">
      {domains.map((d) => (
        <div key={d.domain} className="flex items-center gap-2">
          <span className="text-[14px] text-ink-2 w-16 truncate text-right">
            {d.domain}
          </span>
          <div className="flex-1 h-4 bg-surface-2 rounded overflow-hidden">
            <div
              className="h-full bg-blue-500/40 rounded"
              style={{ width: `${(d.count / max) * 100}%` }}
            />
          </div>
          <span className="text-[13px] text-ink-3 font-mono w-6 text-right tabular-nums">
            {d.count}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function ConfigDriftRadar() {
  const { data, isLoading } = useConfigChanges();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const { domains, total } = useMemo(() => {
    if (!data?.events) return { domains: [], total: 0 };

    const allDomains = extractDomains(data.events);
    // Take top 8 domains
    const topDomains = allDomains.slice(0, 8);
    const t = topDomains.reduce((s, d) => s + d.count, 0);

    return { domains: topDomains, total: t };
  }, [data]);

  // Radar chart dimensions
  const size = 280;
  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = 100;
  const labelOffset = 22;

  const sides = domains.length;
  const maxCount = domains.reduce((m, d) => Math.max(m, d.count), 1);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="flex items-center justify-center h-[320px]">
          <div className="w-[280px] h-[280px] rounded-full border-2 border-line-2 animate-pulse" />
        </div>
      </div>
    );
  }

  if (domains.length === 0) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
          Config Drift Radar
        </h3>
        <div className="flex items-center justify-center py-8">
          <p className="text-xs text-ink-3">No config changes recorded</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
      <h3 className="text-xs font-medium text-ink-2 uppercase tracking-wider mb-3">
        Config Drift Radar
      </h3>

      {domains.length < 3 ? (
        <BarFallback domains={domains} />
      ) : (
        <div className="flex justify-center">
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="overflow-visible"
          >
            {/* Background grid: 3 concentric polygons */}
            {[0.33, 0.66, 1.0].map((scale) => (
              <polygon
                key={`grid-${scale}`}
                points={buildPolygonPoints(cx, cy, maxRadius * scale, sides)}
                fill="none"
                stroke="var(--line-1)"
                strokeWidth={0.5}
              />
            ))}

            {/* Axis lines from center to each vertex */}
            {domains.map((_, i) => {
              const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
              const { x, y } = polarToCartesian(cx, cy, maxRadius, angle);
              return (
                <line
                  key={`axis-${i}`}
                  x1={cx}
                  y1={cy}
                  x2={x}
                  y2={y}
                  stroke="var(--line-1)"
                  strokeWidth={0.5}
                  opacity={0.5}
                />
              );
            })}

            {/* Data polygon */}
            <polygon
              points={domains
                .map((d, i) => {
                  const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
                  const r = (d.count / maxCount) * maxRadius;
                  const { x, y } = polarToCartesian(cx, cy, r, angle);
                  return `${x.toFixed(1)},${y.toFixed(1)}`;
                })
                .join(" ")}
              fill="rgba(59, 130, 246, 0.15)"
              stroke="rgba(96, 165, 250, 0.6)"
              strokeWidth={2}
            />

            {/* Vertex dots and labels */}
            {domains.map((d, i) => {
              const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
              const r = (d.count / maxCount) * maxRadius;
              const point = polarToCartesian(cx, cy, r, angle);
              const labelPoint = polarToCartesian(
                cx,
                cy,
                maxRadius + labelOffset,
                angle
              );
              const isHovered = hoveredIndex === i;

              return (
                <g
                  key={`vertex-${i}`}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  style={{ cursor: "default" }}
                >
                  {/* Highlight axis on hover */}
                  {isHovered && (
                    <line
                      x1={cx}
                      y1={cy}
                      x2={point.x}
                      y2={point.y}
                      stroke="rgba(96, 165, 250, 0.4)"
                      strokeWidth={2}
                    />
                  )}

                  {/* Data point dot */}
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={isHovered ? 5 : 4}
                    fill="#60a5fa"
                    className="transition-all duration-150"
                  />

                  {/* Domain label */}
                  <text
                    x={labelPoint.x}
                    y={labelPoint.y - 5}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={10}
                    fill={isHovered ? "#d4d4d8" : "var(--ink-2)"}
                    fontWeight={isHovered ? 500 : 400}
                  >
                    {d.domain}
                  </text>

                  {/* Count under domain name */}
                  <text
                    x={labelPoint.x}
                    y={labelPoint.y + 7}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={9}
                    fill="var(--ink-3)"
                    fontFamily="monospace"
                  >
                    {d.count}
                  </text>

                  {/* Hit area (invisible larger circle for easier hover) */}
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={12}
                    fill="transparent"
                  />
                </g>
              );
            })}

            {/* Center stability score */}
            <StabilityScore total={total} cx={cx} cy={cy} />
          </svg>
        </div>
      )}
    </div>
  );
}
