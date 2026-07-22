"use client";

import { Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Webhook, ArrowLeft, FileCode, Globe } from "lucide-react";
import Link from "next/link";
import EmptyStateGuide from "@/components/EmptyStateGuide";
import { PageShell, PageHeader, Panel, StatTile, Pill } from "@/components/ui/chrome";
import SystemHealthPanel from "@/components/SystemHealthPanel";

interface HookEntry {
  event: string;
  matcher: string;
  type: string;
  command: string;
  fileName: string;
}

interface HookDetail {
  name: string;
  content: string;
  filePath: string;
  lastModified: string;
  size: number;
}

type Dimension = "health" | "money" | "freedom" | "creative" | "relationships" | "rhythms";

const EVENT_DIMENSIONS: Record<string, Dimension> = {
  PreToolUse: "creative",
  PostToolUse: "rhythms",
  PostToolUseFailure: "creative",
  UserPromptSubmit: "creative",
  Notification: "freedom",
  PreCompact: "relationships",
  PostCompact: "rhythms",
  SessionStart: "freedom",
  SessionEnd: "relationships",
  SubagentStart: "health",
  SubagentStop: "relationships",
  Stop: "relationships",
  StopFailure: "creative",
  TaskCreated: "money",
  TaskCompleted: "health",
  TeammateIdle: "rhythms",
  ConfigChange: "money",
  PermissionRequest: "creative",
  FileChanged: "freedom",
  CwdChanged: "rhythms",
  InstructionsLoaded: "relationships",
  Elicitation: "freedom",
  ElicitationResult: "relationships",
};

function eventDimension(event: string): Dimension {
  return EVENT_DIMENSIONS[event] || "money";
}

function HooksLanding({ hooks, events }: { hooks: HookEntry[]; events: string[] }) {
  const grouped = new Map<string, HookEntry[]>();
  for (const hook of hooks) {
    const list = grouped.get(hook.event) || [];
    list.push(hook);
    grouped.set(hook.event, list);
  }

  for (const event of events) {
    if (!grouped.has(event)) {
      grouped.set(event, []);
    }
  }

  const sortedEvents = [...grouped.keys()].sort();

  return (
    <PageShell>
      {hooks.length === 0 && (
        <EmptyStateGuide
          section="Hook Activity"
          description="Per-hook health, latency, and recent invocations. Populates as hooks fire during your sessions."
          hideInterview
          daPromptExample="show me which hooks fired in this session"
        />
      )}
      <PageHeader
        title="Hooks"
        icon={Webhook}
        subtitle="Lifecycle event handlers that run shell commands or HTTP requests in response to Claude Code events. Configured in settings.json; they intercept tool calls, session events, and system changes."
      />

      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 220px))" }}>
        <StatTile label="Hooks" value={hooks.length} icon={Webhook} dim="money" />
        <StatTile label="Events" value={events.length} icon={FileCode} dim="freedom" />
      </div>

      <SystemHealthPanel />

      <div className="flex flex-col gap-6">
        {sortedEvents.map((event) => {
          const eventHooks = grouped.get(event) || [];
          const dimension = eventDimension(event);

          return (
            <div key={event} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Pill dim={dimension}>{event}</Pill>
                <span className="text-[12px] text-ink-3 mono">({eventHooks.length})</span>
              </div>
              {eventHooks.length === 0 ? (
                <p className="pl-1 text-[13px] italic text-ink-3">No hooks registered</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {eventHooks.map((hook, i) => (
                    <Link
                      key={`${hook.event}-${hook.matcher}-${i}`}
                      href={`/hooks?name=${encodeURIComponent(hook.fileName)}`}
                      className="block"
                    >
                      <Panel hover className="py-3 px-4">
                        <div className="flex items-center gap-3 flex-wrap">
                          {hook.type === "http" ? (
                            <Globe className="w-4 h-4 shrink-0 text-dim-freedom" />
                          ) : (
                            <FileCode className="w-4 h-4 shrink-0 text-dim-money" />
                          )}
                          <span className="mono text-[13px] text-ink-1">{hook.fileName}</span>
                          <span className="text-[12px] text-ink-3">
                            matcher:{" "}
                            <span className="mono text-ink-2">{hook.matcher}</span>
                          </span>
                          <span className="ml-auto shrink-0">
                            <Pill dim={hook.type === "http" ? "freedom" : "money"}>{hook.type}</Pill>
                          </span>
                        </div>
                      </Panel>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </PageShell>
  );
}

function HookDetailView({ hook }: { hook: HookDetail }) {
  return (
    <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-6 flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link href="/hooks" className="text-ink-2 hover:text-ink-1">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-ink-1">{hook.name}</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {(hook.size / 1024).toFixed(1)} KB ·{" "}
            {new Date(hook.lastModified).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
      </div>

      <Panel className="p-0 overflow-hidden">
        <pre className="text-xs mono overflow-x-auto max-h-[700px] overflow-y-auto leading-relaxed p-4 m-0 bg-ground text-ink-2">
          <code>{hook.content}</code>
        </pre>
      </Panel>
    </div>
  );
}

function HooksPageInner() {
  const searchParams = useSearchParams();
  const hookName = searchParams.get("name");
  const isViewing = !!hookName;

  const { data: listData } = useQuery<{ hooks: HookEntry[]; total: number; events: string[] }>({
    queryKey: ["hooks-list"],
    queryFn: async () => {
      const res = await fetch("/api/wiki/hooks");
      if (!res.ok) throw new Error("Failed to fetch hooks");
      return res.json();
    },
    staleTime: 30_000,
    enabled: !isViewing,
  });

  const { data: detailData } = useQuery<HookDetail>({
    queryKey: ["hook-detail", hookName],
    queryFn: async () => {
      const res = await fetch(`/api/wiki/hooks/${encodeURIComponent(hookName!)}`);
      if (!res.ok) throw new Error("Failed to fetch hook");
      return res.json();
    },
    enabled: isViewing,
  });

  if (isViewing && detailData) {
    return <HookDetailView hook={detailData} />;
  }

  if (!isViewing && listData) {
    return <HooksLanding hooks={listData.hooks} events={listData.events} />;
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-sm text-ink-3">Loading...</div>
    </div>
  );
}

export default function HooksPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <div className="text-sm text-ink-3">Loading...</div>
        </div>
      }
    >
      <HooksPageInner />
    </Suspense>
  );
}
