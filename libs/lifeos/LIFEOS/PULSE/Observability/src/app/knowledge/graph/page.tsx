"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { wikiPageUrl } from "@/lib/wiki-links";
import KnowledgeGraph from "@/components/wiki/KnowledgeGraph";
import { Network, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/ui/chrome";

interface GraphData {
  nodes: Array<{
    id: string;
    title: string;
    category: string;
    quality?: number;
    backlinkCount: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
  }>;
}

const CATEGORIES = [
  { key: "system-doc", label: "System", color: "#22d3ee" },
  { key: "person", label: "People", color: "#38bdf8" },
  { key: "company", label: "Companies", color: "#fbbf24" },
  { key: "idea", label: "Ideas", color: "#a78bfa" },
];

export default function GraphPage() {
  const router = useRouter();
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  const { data, isLoading } = useQuery<GraphData>({
    queryKey: ["wiki-graph"],
    queryFn: async () => {
      const res = await fetch("/api/wiki/graph");
      if (!res.ok) throw new Error("Failed to fetch graph data");
      return res.json();
    },
    staleTime: 60_000,
  });

  const handleNodeClick = (slug: string, category: string) => {
    router.push(wikiPageUrl(category, slug));
  };

  const toggleCategory = (key: string) => {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-xs text-ink-3" style={{ fontFamily: "'concourse-t3', sans-serif" }}>
          Loading graph...
        </div>
      </div>
    );
  }

  const visibleCount = data.nodes.filter((n) => !hiddenCategories.has(n.category)).length;

  return (
    <PageShell fullBleed className="h-full">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-line-2 bg-surface-1 shrink-0">
        <Network className="w-4 h-4 text-dim-relationships" />
        <h1
          className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3"
          style={{ fontFamily: "'concourse-c3', 'concourse-t3', sans-serif" }}
        >
          KNOWLEDGE GRAPH
        </h1>
        <span className="text-[13px] text-ink-3 ml-1" style={{ fontFamily: "'concourse-t3', sans-serif" }}>
          {visibleCount} nodes · {data.edges.length} edges
        </span>

        {/* Search */}
        <div className="ml-4 relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-3" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search nodes..."
            className="pl-7 pr-3 py-1 text-[14px] w-48 rounded-md bg-surface-2 border border-line-2 text-ink-2 placeholder:text-ink-3 focus:outline-none focus:border-line-3"
            style={{ fontFamily: "'concourse-t3', sans-serif" }}
          />
        </div>

        {/* Category toggles — dot colors are the graph node color scale (intentional) */}
        <div className="ml-auto flex items-center gap-3">
          {CATEGORIES.map((cat) => {
            const hidden = hiddenCategories.has(cat.key);
            const count = data.nodes.filter((n) => n.category === cat.key).length;
            return (
              <button
                key={cat.key}
                onClick={() => toggleCategory(cat.key)}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border transition-all",
                  hidden
                    ? "opacity-40 hover:opacity-60 border-transparent bg-[rgba(168,165,200,0.05)]"
                    : "border-[rgba(168,165,200,0.22)] bg-[rgba(168,165,200,0.10)] hover:bg-surface-3"
                )}
              >
                <div
                  className="w-2.5 h-2.5 rounded-full transition-all"
                  style={{ backgroundColor: hidden ? "var(--ink-3)" : cat.color }}
                />
                <span
                  className={cn("text-[13px]", hidden ? "text-ink-3" : "text-ink-2")}
                  style={{ fontFamily: "'concourse-t3', sans-serif" }}
                >
                  {cat.label}
                </span>
                <span
                  className="text-[13px] text-ink-3 tabular-nums"
                  style={{ fontFamily: "'concourse-t3', sans-serif" }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Help hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 text-[13px] text-ink-3 bg-surface-1 px-3 py-1 rounded-full border border-line-2 pointer-events-none" style={{ fontFamily: "'concourse-t3', sans-serif" }}>
        click node to focus · click again to open · click background to reset · scroll to zoom
      </div>

      {/* Graph */}
      <div className="flex-1 overflow-hidden">
        <KnowledgeGraph
          nodes={data.nodes}
          edges={data.edges}
          onNodeClick={handleNodeClick}
          hiddenCategories={hiddenCategories}
          searchQuery={searchQuery}
        />
      </div>
    </PageShell>
  );
}
