"use client";

import { useQuery } from "@tanstack/react-query";
import WikiSidebar from "@/components/wiki/WikiSidebar";
import { openPalette } from "@/lib/palette/events";

interface TreeNode {
  label: string;
  slug?: string;
  category?: string;
  children?: TreeNode[];
  count?: number;
}

const KNOWLEDGE_LABELS = new Set(["people", "companies", "ideas", "blogs", "books", "research"]);

function filterKnowledgeTree(tree: TreeNode[]): TreeNode[] {
  return tree.filter((node) => KNOWLEDGE_LABELS.has(node.label?.toLowerCase() ?? ""));
}

export default function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  // ⌘K is handled globally by CommandPalette (opens WIKI-scoped on this route).
  const { data } = useQuery<{ tree: TreeNode[] }>({
    queryKey: ["wiki-tree"],
    queryFn: async () => {
      const res = await fetch("/api/wiki");
      if (!res.ok) throw new Error("Failed to fetch wiki index");
      return res.json();
    },
    staleTime: 30_000,
  });

  const knowledgeTree = data?.tree ? filterKnowledgeTree(data.tree) : [];

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      <WikiSidebar tree={knowledgeTree} onSearchClick={() => openPalette("wiki")} />
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
