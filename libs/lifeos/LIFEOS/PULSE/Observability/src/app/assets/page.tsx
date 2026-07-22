"use client";

import { useEffect, useMemo, useState } from "react";
import { Boxes, Cpu, Radio, Network, Search } from "lucide-react";
import { PageShell, PageHeader, Panel, Pill, EmptyState } from "@/components/ui/chrome";
import type { Dim } from "@/components/ui/chrome";

/**
 * Assets tab — a unified, read-only inventory of everything the user owns, merged
 * from USER/GEAR.md and a network topology snapshot. Zero data in this component;
 * it fetches /api/assets and renders it, grouped by category.
 */

interface Asset {
  name: string;
  category: string;
  detail: string;
  use: string;
  source: string;
  ip?: string;
}
interface AssetsData {
  count: number;
  sources: string[];
  generatedAt: string;
  categories: string[];
  networkEndpoints: number;
  assets: Asset[];
  error?: string;
}

const SOURCE_DIM: Record<string, Dim> = {
  "GEAR.md": "freedom",
  "topology-snapshot": "health",
};

export default function AssetsPage() {
  const [data, setData] = useState<AssetsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("All");

  useEffect(() => {
    fetch("/api/assets", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  const filtered = useMemo(() => {
    const items = data?.assets ?? [];
    const needle = q.trim().toLowerCase();
    return items.filter((a) => {
      if (cat !== "All" && a.category !== cat) return false;
      if (!needle) return true;
      return [a.name, a.detail, a.use, a.category, a.ip].some((f) => f?.toLowerCase().includes(needle));
    });
  }, [data, q, cat]);

  // Group filtered assets by category for section rendering.
  const grouped = useMemo(() => {
    const g = new Map<string, Asset[]>();
    for (const a of filtered) {
      const arr = g.get(a.category) ?? [];
      arr.push(a);
      g.set(a.category, arr);
    }
    return [...g.entries()];
  }, [filtered]);

  const categories = ["All", ...(data?.categories ?? [])];

  return (
    <PageShell>
      <PageHeader
        title="Assets"
        icon={Boxes}
        subtitle={
          <>
            Everything you own — gear, studio, network, smart home — from your{" "}
            <code className="text-ink-2">GEAR.md</code> and network topology.
            {data?.count ? ` ${data.count} items.` : ""}
            {data?.networkEndpoints ? ` ${data.networkEndpoints} endpoints seen on the LAN.` : ""}
          </>
        }
      />

      {data && data.assets.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="relative w-full sm:max-w-sm">
            <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by name, model, category, IP…"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-surface-1 border border-line-2 text-sm text-ink-1 placeholder:text-ink-3 focus:outline-none focus:border-line-3"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCat(c)}
                className="text-[12px] px-2.5 py-1 rounded-md border transition-colors"
                style={
                  cat === c
                    ? { background: "var(--surface-3)", borderColor: "var(--line-3)", color: "var(--ink-1)" }
                    : { background: "var(--surface-1)", borderColor: "var(--line-2)", color: "var(--ink-2)" }
                }
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="text-warn text-sm">Couldn&apos;t reach Assets API: {error}</div>}
      {!data && !error && <div className="text-ink-3 text-sm">Loading…</div>}
      {data && data.assets.length === 0 && !error && (
        <EmptyState
          icon={Boxes}
          title={data.error ? "Couldn't read asset sources" : "No assets yet"}
          hint={data.error ? data.error : "No assets found in GEAR.md yet."}
        />
      )}

      {grouped.map(([category, items]) => (
        <section key={category}>
          <div className="flex items-center gap-2 mb-3">
            <CategoryIcon category={category} />
            <h2 className="text-sm font-semibold text-ink-2 tracking-wide uppercase">{category}</h2>
            <span className="text-[11px] text-ink-3">{items.length}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((a, i) => (
              <Panel key={`${a.name}-${i}`} hover className="p-4 flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-ink-1 font-medium leading-snug">{a.name}</div>
                  <Pill dim={SOURCE_DIM[a.source] ?? "neutral"} className="shrink-0 text-[10px]">
                    {a.source === "GEAR.md" ? "gear" : "network"}
                  </Pill>
                </div>
                {a.detail && <div className="text-ink-2 text-sm leading-snug">{a.detail}</div>}
                {a.use && <div className="text-ink-3 text-[13px] leading-snug">{a.use}</div>}
                {a.ip && (
                  <code className="text-[12px] text-ink-3 mt-0.5" data-sensitive title={a.ip}>
                    {a.ip}
                  </code>
                )}
              </Panel>
            ))}
          </div>
        </section>
      ))}
    </PageShell>
  );
}

function CategoryIcon({ category }: { category: string }) {
  const c = category.toLowerCase();
  if (/network|switch/.test(c)) return <Network className="w-4 h-4 text-dim-health" />;
  if (/smart home|camera|light|sensor/.test(c)) return <Radio className="w-4 h-4 text-dim-health" />;
  return <Cpu className="w-4 h-4 text-dim-freedom" />;
}
