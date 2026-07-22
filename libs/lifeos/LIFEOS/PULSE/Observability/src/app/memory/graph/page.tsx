"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import KnowledgeGraph from "@/components/wiki/KnowledgeGraph";
import { Network, Search, ArrowLeft, CornerDownRight } from "lucide-react";

interface MemNode { id: string; title: string; category: string; backlinkCount: number; silo: string; pagerank: number }
interface MemEdge { source: string; target: string; kind: string }
interface Community { id: number; key: string; size: number; lead: string }
interface MemGraph { nodes: MemNode[]; edges: MemEdge[]; communities: Community[]; built: string | null; nodeCount?: number; edgeCount?: number }

const KIND_ORDER = ["related", "wikilink", "inferred", "tag"];
const KIND_LABEL: Record<string, string> = { related: "Declared (typed)", wikilink: "Wikilinks", inferred: "Inferred (similar)", tag: "Shared tags" };
const NEIGHBOR_CAP = 36;

export default function MemoryGraphPage() {
  const [focus, setFocus] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [q, setQ] = useState("");

  const { data, isLoading } = useQuery<MemGraph>({
    queryKey: ["memory-graph"],
    queryFn: async () => {
      const res = await fetch("/api/memory/graph");
      if (!res.ok) throw new Error("Failed to fetch memory graph");
      return res.json();
    },
    staleTime: 60_000,
  });

  const nodeById = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);

  // adjacency: id -> [{id, kind}]
  const adj = useMemo(() => {
    const m = new Map<string, { id: string; kind: string }[]>();
    for (const e of data?.edges ?? []) {
      (m.get(e.source) ?? m.set(e.source, []).get(e.source)!).push({ id: e.target, kind: e.kind });
      (m.get(e.target) ?? m.set(e.target, []).get(e.target)!).push({ id: e.source, kind: e.kind });
    }
    return m;
  }, [data]);

  const colorMap = useMemo(() => {
    const m: Record<string, string> = {};
    (data?.communities ?? []).forEach((c, i) => {
      m[c.key] = `hsl(${Math.round((i * 360) / Math.max((data?.communities ?? []).length, 1))}, 68%, 56%)`;
    });
    return m;
  }, [data]);

  // Overview constellation: top hubs by pagerank + each community's lead, so the
  // canvas is never empty and every community is represented before a focus is picked.
  const overview = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    const picked = new Set<string>();
    const byRank = [...data.nodes].sort((a, b) => b.pagerank - a.pagerank);
    for (const c of data.communities) {
      const lead = data.nodes.find((n) => n.category === c.key);
      if (lead) picked.add(lead.id);
    }
    for (const n of byRank) { if (picked.size >= 140) break; picked.add(n.id); }
    return {
      // Cap backlinkCount so hub radii stay readable — uncapped hubs render as
      // giant overlapping blobs that merge whole communities into one shape.
      nodes: [...picked].map((id) => nodeById.get(id)!).filter(Boolean)
        .map((n) => ({ ...n, backlinkCount: Math.min(n.backlinkCount, 30) })),
      edges: data.edges.filter((e) => picked.has(e.source) && picked.has(e.target)),
    };
  }, [data, nodeById]);

  const go = (id: string) => { if (focus) setTrail((t) => [...t, focus]); setFocus(id); setQ(""); };
  const back = () => { setTrail((t) => { const n = [...t]; const prev = n.pop(); setFocus(prev ?? null); return n; }); };

  if (isLoading || !data) {
    return <div className="flex items-center justify-center h-full"><div className="text-xs text-ink-3" style={{ fontFamily: "'concourse-t3', sans-serif" }}>Loading memory graph…</div></div>;
  }

  // Search results (title contains query)
  const results = q.trim().length >= 2
    ? data.nodes.filter((n) => n.title.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.pagerank - a.pagerank).slice(0, 14)
    : [];

  // Neighborhood subgraph for the focused node
  const focusNode = focus ? nodeById.get(focus) : null;
  const neighbors = focus ? (adj.get(focus) ?? []) : [];
  // dedupe neighbor ids, keep strongest kind, cap by neighbor pagerank
  const seen = new Map<string, string>();
  for (const nb of neighbors) if (!seen.has(nb.id)) seen.set(nb.id, nb.kind);
  const neighborIds = [...seen.keys()].sort((a, b) => (nodeById.get(b)?.pagerank ?? 0) - (nodeById.get(a)?.pagerank ?? 0)).slice(0, NEIGHBOR_CAP);
  const subIds = new Set<string>([...(focus ? [focus] : []), ...neighborIds]);
  const subNodes = [...subIds].map((id) => nodeById.get(id)!).filter(Boolean);
  const subEdges = data.edges.filter((e) => subIds.has(e.source) && subIds.has(e.target));

  // Connections grouped by kind for the side panel
  const grouped: Record<string, { id: string; title: string; silo: string }[]> = {};
  for (const id of neighborIds) {
    const k = seen.get(id)!; const n = nodeById.get(id); if (!n) continue;
    (grouped[k] ??= []).push({ id, title: n.title, silo: n.silo });
  }

  const startPoints = [...data.communities].sort((a, b) => b.size - a.size);

  return (
    <div className="flex flex-col h-[calc(100vh-160px)] min-h-[560px]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-line-2 bg-surface-1 shrink-0">
        <Network className="w-4 h-4 text-dim-relationships" />
        <h1 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3 shrink-0 whitespace-nowrap" style={{ fontFamily: "'concourse-c3', 'concourse-t3', sans-serif" }}>Memory Graph</h1>
        <div className="relative ml-4 flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any memory item…"
            className="w-full bg-surface-2 border border-line-2 rounded pl-7 pr-2 py-1 text-[12px] text-ink-1 outline-none focus:border-line-3"
            style={{ fontFamily: "'concourse-t3', sans-serif" }}
          />
          {results.length > 0 && (
            <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto bg-surface-2 border border-line-2 rounded shadow-xl">
              {results.map((r) => (
                <button key={r.id} onClick={() => go(r.id)} className="block w-full text-left px-2 py-1 text-[12px] text-ink-2 hover:bg-surface-3 hover:text-ink-1 truncate" style={{ fontFamily: "'concourse-t3', sans-serif" }}>
                  <span className="text-ink-3 text-[10px] uppercase mr-1">{r.silo}</span>{r.title}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="text-[11px] text-ink-3 shrink-0 whitespace-nowrap ml-auto" style={{ fontFamily: "'concourse-t3', sans-serif" }}>{data.nodeCount} nodes · {data.communities.length} communities</span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Side panel: focus + clickable connections (the useful part) */}
        <div className="w-80 shrink-0 overflow-y-auto border-r border-line-2 bg-surface-1 p-3">
          {!focusNode ? (
            <div>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {[
                  { n: data.nodes.length.toLocaleString(), l: "items" },
                  { n: data.edges.length.toLocaleString(), l: "links" },
                  { n: String(data.communities.length), l: "clusters" },
                ].map((s) => (
                  <div key={s.l} className="rounded-md border border-line-2 bg-surface-2 px-2 py-2 text-center">
                    <div className="text-[15px] text-ink-1 font-medium" style={{ fontFamily: "'advocate-c14', sans-serif" }}>{s.n}</div>
                    <div className="text-[9px] uppercase tracking-[0.14em] text-ink-3" style={{ fontFamily: "'concourse-t3', sans-serif" }}>{s.l}</div>
                  </div>
                ))}
              </div>
              <div className="text-[11px] leading-relaxed text-ink-3 mb-4" style={{ fontFamily: "'concourse-t3', sans-serif" }}>
                Click any node or cluster to walk its connections. Search finds anything by name.
              </div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-3 mb-2" style={{ fontFamily: "'concourse-c3', 'concourse-t3', sans-serif" }}>Clusters</div>
              <div className="space-y-0.5">
                {startPoints.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => go(data.nodes.find((n) => n.category === c.key)?.id ?? c.lead)}
                    className="flex items-center gap-2.5 w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-3 group transition-colors"
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-inset ring-white/10" style={{ background: colorMap[c.key] }} />
                    <span className="flex-1 min-w-0 text-[12px] text-ink-2 truncate group-hover:text-ink-1" style={{ fontFamily: "'concourse-t3', sans-serif" }}>{c.lead}</span>
                    <span className="text-[10px] tabular-nums text-ink-3 group-hover:text-ink-2" style={{ fontFamily: "'concourse-t3', sans-serif" }}>{c.size}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-2">
                {trail.length > 0 && <button onClick={back} className="text-ink-2 hover:text-ink-1"><ArrowLeft className="w-3.5 h-3.5" /></button>}
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colorMap[focusNode.category] }} />
                <span className="text-[10px] uppercase text-ink-3">{focusNode.silo}</span>
              </div>
              <div className="text-[14px] text-ink-1 font-medium mb-1 leading-snug" style={{ fontFamily: "'advocate-c14', sans-serif" }}>{focusNode.title}</div>
              <div className="text-[11px] text-ink-3 mb-3" style={{ fontFamily: "'concourse-t3', sans-serif" }}>{neighborIds.length} connections</div>
              {KIND_ORDER.filter((k) => grouped[k]?.length).map((k) => (
                <div key={k} className="mb-3">
                  <div className="text-[10px] uppercase tracking-wider text-ink-3 mb-1" style={{ fontFamily: "'advocate-c14', sans-serif" }}>{KIND_LABEL[k]} ({grouped[k].length})</div>
                  <div className="space-y-1.5">
                    {grouped[k].map((n) => (
                      <button key={n.id} onClick={() => go(n.id)} className="flex items-start gap-1.5 w-full text-left group">
                        <CornerDownRight className="w-3 h-3 text-ink-3 mt-[3px] shrink-0 group-hover:text-dim-relationships" />
                        <span className="flex-1 min-w-0 text-[12px] text-ink-2 group-hover:text-ink-1" style={{ fontFamily: "'concourse-t3', sans-serif", lineHeight: 1.35 }}>
                          <span className="text-ink-3 text-[10px] uppercase mr-1 align-baseline">{n.silo}</span>{n.title}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Canvas: overview constellation by default, focused neighborhood once picked */}
        <div className="flex-1 min-w-0 relative">
          {focusNode
            ? <KnowledgeGraph nodes={subNodes} edges={subEdges} colorMap={colorMap} onNodeClick={(slug) => go(slug)} />
            : (
              <>
                <KnowledgeGraph nodes={overview.nodes} edges={overview.edges} colorMap={colorMap} onNodeClick={(slug) => go(slug)} />
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-surface-1 border border-line-2 text-[10px] tracking-[0.1em] uppercase text-ink-3 pointer-events-none" style={{ fontFamily: "'concourse-t3', sans-serif" }}>
                  Top {overview.nodes.length} hubs of {data.nodes.length.toLocaleString()} — click to explore
                </div>
              </>
            )}
        </div>
      </div>
    </div>
  );
}
