"use client";

import { useState } from "react";
import UnifiedWorkDashboard from "@/components/activity/UnifiedWorkDashboard";
import ObservabilityDashboard from "@/components/activity/ObservabilityDashboard";
import NativeDashboard from "@/components/activity/NativeDashboard";
import OptimizeDashboard from "@/components/activity/OptimizeDashboard";
import LoopDashboard from "@/components/activity/LoopDashboard";
import SystemHealthVitals from "@/components/activity/insights/SystemHealthVitals";
import { PageShell, TabBar, dimStyle, type TabSpec } from "@/components/ui/chrome";
import { Repeat, TrendingUp, Terminal, RefreshCw, Zap } from "lucide-react";


// ─── Main Agents Page ───
// Tabs: Iterate | Optimize | Loop | Native (left) | Actions (right)
// System Health Vitals bar persists across all tabs
//
// CANONICAL DOC for what each tab means, ISA frontmatter mapping, and dashboard
// component links: ~/.claude/LIFEOS/ALGORITHM/modes/README.md
// Per-mode doctrine: ~/.claude/LIFEOS/ALGORITHM/modes/{iterate,optimize,ideate,loop,native}.md
// Short summary lives in ~/.claude/LIFEOS/DOCUMENTATION/Algorithm/AlgorithmSystem.md
// under "## Mode System". This `modeTabs` array below is the runtime source of truth
// for tab labels and ordering — the docs above must stay in sync with it.

type Tab = "iterate" | "optimize" | "loop" | "native" | "actions";

const modeTabs: TabSpec<Tab>[] = [
  { id: "iterate", label: "Iterate", icon: Repeat, dim: "creative" },
  { id: "optimize", label: "Optimize", icon: TrendingUp, dim: "rhythms" },
  { id: "loop", label: "Loop", icon: RefreshCw, dim: "relationships" },
  { id: "native", label: "Native", icon: Terminal, dim: "money" },
];

export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>("iterate");
  const actionsActive = tab === "actions";

  return (
    <PageShell fullBleed>
      <SystemHealthVitals />

      {/* Tab bar: mode tabs left, Actions right */}
      <TabBar
        className="px-4 py-2 shrink-0 border-b border-line-2 bg-surface-2"
        tabs={modeTabs}
        active={tab}
        onChange={setTab}
        right={
          <button
            type="button"
            onClick={() => setTab("actions")}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium cursor-pointer transition-colors duration-150"
            style={{
              ...dimStyle("creative", actionsActive),
              ...(actionsActive ? { color: "var(--ink-1)" } : {}),
            }}
          >
            <Zap className="w-4 h-4" />
            Actions
          </button>
        }
      />

      {/* Tab content */}
      {tab === "iterate" && <UnifiedWorkDashboard />}
      {tab === "optimize" && <OptimizeDashboard />}
      {tab === "loop" && <LoopDashboard />}
      {tab === "native" && <NativeDashboard />}
      {tab === "actions" && <ObservabilityDashboard />}
    </PageShell>
  );
}
