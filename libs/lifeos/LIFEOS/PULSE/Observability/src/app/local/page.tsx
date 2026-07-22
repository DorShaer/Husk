"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Building2,
  Shield,
  Briefcase,
  Users,
  ScrollText,
  Vote,
  Gavel,
  Newspaper,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { PageShell, PageHeader, Panel, Pill, EmptyState, type Dim } from "@/components/ui/chrome";

type SourceStatus = "ok" | "unavailable" | "empty";
type Item = { title: string; source: string; url: string; date: string; summary?: string };
type FetchResult = { items: Item[]; source_status: SourceStatus; errors?: string[] };

interface Digest {
  meta: {
    city: string;
    state: string;
    county?: string;
    zip?: string;
    generated_at: string;
    sources_used: string[];
    sources_failed: string[];
    errors: string[];
  };
  construction: FetchResult;
  crime: FetchResult;
  business: FetchResult;
  officials: FetchResult;
  legislation: FetchResult;
  elections: FetchResult;
  arrests: FetchResult;
  news: FetchResult;
}

type SectionKey =
  | "construction"
  | "crime"
  | "business"
  | "officials"
  | "legislation"
  | "elections"
  | "arrests"
  | "news";

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  dim: Dim;
  emptyHint: string;
}

const SECTIONS: SectionDef[] = [
  { key: "construction", label: "Construction", icon: Building2, dim: "money", emptyHint: "No new construction permits this week." },
  { key: "crime", label: "Crime", icon: Shield, dim: "err", emptyHint: "No new crime stats this week." },
  { key: "business", label: "New Business", icon: Briefcase, dim: "ok", emptyHint: "No new business openings this week." },
  { key: "officials", label: "Officials", icon: Users, dim: "blue", emptyHint: "No officials news this week." },
  { key: "legislation", label: "Legislation", icon: ScrollText, dim: "relationships", emptyHint: "No pending or enacted laws this week." },
  { key: "elections", label: "Elections", icon: Vote, dim: "freedom", emptyHint: "No upcoming elections." },
  { key: "arrests", label: "Arrests", icon: Gavel, dim: "warn", emptyHint: "No new arrests reported this week." },
  { key: "news", label: "Local News", icon: Newspaper, dim: "rhythms", emptyHint: "No local news this week." },
];

function relativeTime(iso: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const ago = Math.floor((Date.now() - t) / 1000);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  if (ago < 86400 * 30) return `${Math.floor(ago / 86400)}d ago`;
  if (ago < 86400 * 365) return `${Math.floor(ago / (86400 * 30))}mo ago`;
  return `${Math.floor(ago / (86400 * 365))}y ago`;
}

function RefreshButton({ refreshing, onClick }: { refreshing: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={refreshing}
      className="inline-flex items-center gap-2 rounded-md border border-line-2 hover:border-line-3 disabled:opacity-50 px-3 py-1.5 text-sm text-ink-2 transition-colors"
    >
      <RefreshCw className={refreshing ? "w-4 h-4 animate-spin" : "w-4 h-4"} />
      {refreshing ? "Refreshing…" : "Refresh now"}
    </button>
  );
}

export default function LocalPage() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/local-intelligence", { cache: "no-store" });
      if (!res.ok) {
        setError(res.status === 404 ? "not-yet-generated" : `http_${res.status}`);
        setDigest(null);
        return;
      }
      const j = (await res.json()) as Digest;
      setDigest(j);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setDigest(null);
    }
  }, []);

  const refreshNow = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/local-intelligence/refresh", { method: "POST" });
      const start = Date.now();
      while (Date.now() - start < 90_000) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await fetch("/api/local-intelligence", { cache: "no-store" });
        if (res.ok) {
          const j = (await res.json()) as Digest;
          if (!digest || j.meta.generated_at !== digest.meta.generated_at) {
            setDigest(j);
            setError(null);
            break;
          }
        }
      }
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  if (error === "not-yet-generated") {
    return (
      <PageShell>
        <PageHeader title="Local" subtitle="Civic intelligence digest for your hometown." />
        <Panel className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-warn mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-ink-1">No digest generated yet.</p>
            <p className="text-sm text-ink-2 mt-1">
              The first refresh hasn&apos;t completed. Click below to run it now or wait
              for the daily 6 a.m. job.
            </p>
            <div className="mt-4">
              <RefreshButton refreshing={refreshing} onClick={refreshNow} />
            </div>
          </div>
        </Panel>
      </PageShell>
    );
  }

  if (error) {
    return (
      <PageShell>
        <PageHeader title="Local" subtitle="Civic intelligence digest for your hometown." />
        <Panel className="text-sm text-err" style={{ borderColor: "var(--err)" }}>
          Error loading digest: {error}
        </Panel>
      </PageShell>
    );
  }

  if (!digest) {
    return (
      <PageShell>
        <PageHeader title="Local" subtitle="Civic intelligence digest for your hometown." />
        <EmptyState title="Loading…" />
      </PageShell>
    );
  }

  const { meta } = digest;
  const totalSources = meta.sources_used.length + meta.sources_failed.length;

  return (
    <PageShell>
      <PageHeader
        title="Local"
        subtitle={`${meta.city}, ${meta.state} — civic intelligence digest.`}
        actions={
          <>
            <div className="flex items-center gap-2 text-[12px] uppercase tracking-[0.15em] text-ink-3 mono">
              {meta.zip ? <span>{meta.zip}</span> : null}
              {meta.county ? (
                <>
                  <span className="text-ink-3">·</span>
                  <span>{meta.county} County</span>
                </>
              ) : null}
              <span className="text-ink-3">·</span>
              <span>refreshed {relativeTime(meta.generated_at)}</span>
              <span className="text-ink-3">·</span>
              <span className="text-ink-2">
                {meta.sources_used.length}/{totalSources} sources
              </span>
            </div>
            <RefreshButton refreshing={refreshing} onClick={refreshNow} />
          </>
        }
      />

      {/* Card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {SECTIONS.map((section) => {
          const data = digest[section.key];
          const Icon = section.icon;
          const dotColor =
            data.source_status === "ok"
              ? "var(--ok)"
              : data.source_status === "empty"
                ? "var(--ink-3)"
                : "var(--warn)";
          return (
            <Panel key={section.key} as="section" hover className="flex flex-col">
              {/* Section header chip */}
              <header className="flex items-center justify-between mb-4">
                <Pill dim={section.dim}>
                  <Icon className="w-3.5 h-3.5" />
                  <span className="uppercase tracking-[0.16em] font-semibold">{section.label}</span>
                </Pill>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: dotColor }} />
                  <span className="text-[12px] uppercase tracking-wider text-ink-3 mono">
                    {data.source_status}
                  </span>
                </div>
              </header>

              {data.items.length === 0 ? (
                <p className="text-sm text-ink-2 italic">
                  {data.source_status === "unavailable"
                    ? "Source unavailable for this city."
                    : section.emptyHint}
                </p>
              ) : (
                <ul className="space-y-3.5 flex-1">
                  {data.items.slice(0, 7).map((item, i) => (
                    <li key={i} className="group">
                      <a href={item.url} target="_blank" rel="noreferrer" className="block">
                        <div className="text-[14px] font-medium text-ink-1 leading-snug group-hover:text-[color:var(--accent-soft)] transition-colors line-clamp-2">
                          {item.title}
                        </div>
                        {item.summary ? (
                          <p className="mt-1 text-[13px] text-ink-2 leading-relaxed line-clamp-2">
                            {item.summary}
                          </p>
                        ) : null}
                        <div className="mt-1.5 text-[12px] uppercase tracking-[0.15em] text-ink-3 mono tabular-nums flex items-center gap-2">
                          <span className="truncate max-w-[60%]">{item.source}</span>
                          {item.date ? (
                            <>
                              <span className="text-ink-3">·</span>
                              <span>{relativeTime(item.date)}</span>
                            </>
                          ) : null}
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          );
        })}
      </div>

      {/* Errors */}
      {meta.errors.length > 0 ? (
        <details className="text-xs text-ink-3 mono">
          <summary className="cursor-pointer hover:text-ink-2 uppercase tracking-[0.18em]">
            {meta.errors.length} source error{meta.errors.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-3 space-y-1 pl-4">
            {meta.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </PageShell>
  );
}
