"use client";
import { useEffect, useState } from "react";
import {
  Activity,
  Heart,
  Apple,
  FlaskConical,
  Pill as PillIcon,
  Stethoscope,
  ClipboardList,
  FileText,
  Lock,
  type LucideIcon,
} from "lucide-react";
import { FreshnessIndicator, type FreshnessData } from "@/components/FreshnessIndicator";
import EmptyStateGuide from "@/components/EmptyStateGuide";
import { PageShell, PageHeader, Panel, PanelHeader, StatTile, Pill } from "@/components/ui/chrome";

interface HealthFile {
  name: string;
  sections: string[];
}

interface HealthData {
  files?: HealthFile[];
  freshness?: FreshnessData;
}

interface FileMeta {
  icon: LucideIcon;
  label: string;
  priority: number;
}

const FILE_META: Record<string, FileMeta> = {
  METRICS: { icon: Activity, label: "Metrics", priority: 1 },
  FITNESS: { icon: Heart, label: "Fitness", priority: 2 },
  NUTRITION: { icon: Apple, label: "Nutrition", priority: 3 },
  CONDITIONS: { icon: ClipboardList, label: "Conditions", priority: 4 },
  MEDICATIONS: { icon: PillIcon, label: "Medications", priority: 5 },
  PROVIDERS: { icon: Stethoscope, label: "Providers", priority: 6 },
  HISTORY: { icon: FileText, label: "History", priority: 7 },
};

function fileMeta(name: string): FileMeta {
  if (name.startsWith("lab_results")) {
    return {
      icon: FlaskConical,
      label: name.replace(/^lab_results_/, "Labs — "),
      priority: 0,
    };
  }
  return FILE_META[name.toUpperCase()] || { icon: FileText, label: name, priority: 99 };
}

function FileCard({ file }: { file: HealthFile }) {
  const meta = fileMeta(file.name);
  const Icon = meta.icon;
  return (
    <Panel hover style={{ borderLeft: "3px solid var(--health)" }}>
      <PanelHeader
        title={meta.label}
        icon={Icon}
        actions={
          <Pill dim="health" className="tabular-nums">
            {file.sections.length} section{file.sections.length === 1 ? "" : "s"}
          </Pill>
        }
      />
      <div className="space-y-1.5" data-sensitive>
        {file.sections.slice(0, 8).map((s, i) => (
          <div key={i} className="flex items-start gap-2 text-xs text-ink-2">
            <span
              className="w-1 h-1 rounded-full mt-1.5 shrink-0"
              style={{ backgroundColor: "var(--rhythms)", opacity: 0.6 }}
            />
            <span className="line-clamp-2">{s}</span>
          </div>
        ))}
        {file.sections.length > 8 && (
          <div className="text-[12px] italic pt-1 text-ink-3">
            + {file.sections.length - 8} more
          </div>
        )}
      </div>
    </Panel>
  );
}

export default function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/life/health")
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);
  if (error) {
    return (
      <PageShell>
        <Panel style={{ borderLeft: "3px solid var(--err)" }}>
          <h2 className="font-medium text-err">Failed to load health</h2>
          <p className="text-sm text-ink-2">{error}</p>
        </Panel>
      </PageShell>
    );
  }
  if (!data) return <div className="p-8 text-sm text-ink-3">Loading Health...</div>;

  const files = (data.files || [])
    .slice()
    .sort((a, b) => fileMeta(a.name).priority - fileMeta(b.name).priority);
  const labs = files.filter((f) => f.name.startsWith("lab_results"));
  const nonLabs = files.filter((f) => !f.name.startsWith("lab_results"));
  const isFreshInstall = files.length === 0;

  return (
    <PageShell>
      <PageHeader
        title="Health"
        icon={Activity}
        subtitle="Lab results, fitness, nutrition, and trends over time — fully private. Observer mode blurs all data below."
        actions={<FreshnessIndicator freshness={data.freshness} />}
      />

      {isFreshInstall && (
        <EmptyStateGuide
          section="Health Snapshots"
          description="Lab results, fitness data, nutrition tracking, and trends over time."
          userDir="HEALTH"
          daPromptExample="help me set up where my health data lives"
        />
      )}

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
        <StatTile
          label="Tracked Sources"
          value={<span data-sensitive>{files.length}</span>}
          dim="health"
          icon={Activity}
        />
        <StatTile
          label="Lab Panels"
          value={<span data-sensitive>{labs.length}</span>}
          dim="rhythms"
          icon={FlaskConical}
        />
      </div>

      <p className="text-sm flex items-center gap-2 text-ink-3">
        <Lock className="w-3.5 h-3.5" /> Fully private. Observer mode blurs all data below.
      </p>

      {labs.length > 0 && (
        <section>
          <h2 className="text-[13px] font-medium uppercase tracking-widest text-ink-3 mb-4 flex items-center gap-2">
            <FlaskConical className="w-4 h-4" /> Lab Panels
          </h2>
          <div className="prob-grid">
            {labs.map((f) => (
              <FileCard key={f.name} file={f} />
            ))}
          </div>
        </section>
      )}
      {nonLabs.length > 0 && (
        <section>
          <h2 className="text-[13px] font-medium uppercase tracking-widest text-ink-3 mb-4">
            Core Files
          </h2>
          <div className="prob-grid">
            {nonLabs.map((f) => (
              <FileCard key={f.name} file={f} />
            ))}
          </div>
        </section>
      )}
    </PageShell>
  );
}
