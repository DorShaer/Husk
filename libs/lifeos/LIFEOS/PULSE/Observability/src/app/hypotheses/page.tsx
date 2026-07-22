"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Sparkles,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Clock,
} from "lucide-react";
import EmptyStateGuide from "@/components/EmptyStateGuide";
import {
  PageShell,
  PageHeader,
  Panel,
  Pill,
  EmptyState,
  dimStyle,
} from "@/components/ui/chrome";

interface HypothesisSummary {
  slug: string;
  claim: string;
  confidence: number;
  target_frame: string;
  evidence_count: number;
  generated: string;
  expires_in_days: number;
}

interface HypothesisDetail extends HypothesisSummary {
  status: string;
  expires: string;
  evidence_signals: string[];
  falsifier: string;
  evidence: string;
  suggested_action: string;
}

function formatTimestamp(iso: string): string {
  if (!iso || iso === "never") return iso || "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function HypothesisCard({
  hypothesis,
  onGraduate,
  onReject,
}: {
  hypothesis: HypothesisSummary;
  onGraduate: (slug: string) => void;
  onReject: (slug: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<HypothesisDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const confidencePct = Math.round(hypothesis.confidence * 100);
  const expiresSoon = hypothesis.expires_in_days < 7;

  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) {
      setLoadingDetail(true);
      try {
        const resp = await fetch(
          `/api/hypotheses/${encodeURIComponent(hypothesis.slug)}`
        );
        if (resp.ok) setDetail(await resp.json());
      } finally {
        setLoadingDetail(false);
      }
    }
  }

  return (
    <Panel
      className="space-y-3"
      style={expiresSoon ? { borderColor: "var(--warn)" } : undefined}
    >
      <div className="flex items-start gap-3">
        <div
          className="p-2 rounded-lg shrink-0"
          style={dimStyle("relationships", true)}
        >
          <Sparkles size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-ink-1 leading-snug normal-case" style={{ fontFamily: "'concourse-t3', sans-serif" }}>
            {hypothesis.claim || hypothesis.slug}
          </h3>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <Pill dim="ok">{confidencePct}% confidence</Pill>
            <span className="text-ink-3">
              → <span className="text-ink-2">{hypothesis.target_frame}</span>
            </span>
            <span className="text-ink-3">
              {hypothesis.evidence_count} signals
            </span>
            <span
              className={`flex items-center gap-1 ${
                expiresSoon ? "text-warn font-semibold" : "text-ink-3"
              }`}
            >
              <Clock size={11} />
              expires in {hypothesis.expires_in_days}d
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => onGraduate(hypothesis.slug)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
          style={dimStyle("ok", true)}
        >
          <CheckCircle2 size={12} />
          Graduate
        </button>
        <button
          onClick={() => onReject(hypothesis.slug)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
          style={dimStyle("err", true)}
        >
          <XCircle size={12} />
          Reject
        </button>
        <button
          onClick={toggleExpand}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md text-ink-2 hover:text-ink-1 hover:bg-surface-3 transition-colors ml-auto"
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? "Hide" : "Evidence"}
        </button>
      </div>

      {expanded && (
        <div className="pt-3 border-t border-line-1 space-y-3 text-xs">
          {loadingDetail && (
            <div className="text-ink-3 italic">Loading detail…</div>
          )}
          {detail && (
            <>
              <div>
                <div className="text-ink-3 uppercase tracking-wide text-[13px] mb-1">
                  Evidence ({detail.evidence_signals.length} signals)
                </div>
                <ul className="space-y-0.5 text-ink-2 mono">
                  {detail.evidence_signals.slice(0, 8).map((sig) => (
                    <li key={sig} className="truncate">
                      {sig}
                    </li>
                  ))}
                  {detail.evidence_signals.length > 8 && (
                    <li className="text-ink-3">
                      +{detail.evidence_signals.length - 8} more
                    </li>
                  )}
                </ul>
              </div>
              <div>
                <div className="text-ink-3 uppercase tracking-wide text-[13px] mb-1">
                  Falsifier
                </div>
                <p className="text-ink-2">{detail.falsifier}</p>
              </div>
              {detail.suggested_action && (
                <div>
                  <div className="text-ink-3 uppercase tracking-wide text-[13px] mb-1">
                    Suggested Action
                  </div>
                  <p className="text-ink-2">{detail.suggested_action}</p>
                </div>
              )}
              <div className="text-ink-3 text-[12px] mono">
                generated {formatTimestamp(detail.generated)}
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

export default function HypothesesPage() {
  const [items, setItems] = useState<HypothesisSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [actionInFlight, setActionInFlight] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/api/hypotheses");
      if (!resp.ok) {
        setError(`API returned ${resp.status}`);
        return;
      }
      const data = (await resp.json()) as { hypotheses: HypothesisSummary[] };
      setItems(data.hypotheses || []);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load]);

  async function performAction(
    slug: string,
    action: "graduate" | "reject",
    note?: string
  ) {
    setActionInFlight(true);
    try {
      const resp = await fetch(
        `/api/hypotheses/${encodeURIComponent(slug)}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: note || undefined }),
        }
      );
      if (!resp.ok) {
        alert(`Failed: ${resp.status}`);
        return;
      }
      await load();
    } finally {
      setActionInFlight(false);
    }
  }

  function handleGraduate(slug: string) {
    if (actionInFlight) return;
    const confirmed = window.confirm(
      `Graduate this hypothesis to its target frame? This appends to the WISDOM frame and archives the hypothesis.`
    );
    if (!confirmed) return;
    performAction(slug, "graduate");
  }

  function handleReject(slug: string) {
    if (actionInFlight) return;
    const note = window.prompt("Reject reason (optional):") ?? "";
    performAction(slug, "reject", note);
  }

  if (items === null && !error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse text-ink-3 text-sm">
          Loading hypotheses…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <PageShell>
        <EmptyState
          icon={RefreshCw}
          title="Hypothesis API not reachable"
          hint={<span className="mono">{error}</span>}
        />
      </PageShell>
    );
  }

  const hypotheses = items || [];

  return (
    <PageShell>
      <PageHeader
        icon={Sparkles}
        title="Hypotheses"
        subtitle={
          <span className="max-w-2xl inline-block">
            Pending wisdom candidates from the proactive deriver loop. Graduate
            promotes the claim to a{" "}
            <code className="text-ink-2">WISDOM/FRAMES</code> file; reject
            archives it; unreviewed hypotheses age out at 30 days.
          </span>
        }
        actions={
          <span className="flex items-center gap-2 text-xs text-ink-3">
            <RefreshCw size={12} />
            {lastFetch
              ? `synced ${formatTimestamp(lastFetch.toISOString())}`
              : "syncing…"}
          </span>
        }
      />

      {hypotheses.length === 0 ? (
        <EmptyStateGuide
          section="Hypotheses"
          description="No pending hypotheses. The deriver runs nightly at 03:00 — it scans LEARNING signals and emits up to 3 conservative claims per run when patterns cross the confidence/sample thresholds."
          hideInterview
          daPromptExample="run the deriver loop now"
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {hypotheses.map((h) => (
            <HypothesisCard
              key={h.slug}
              hypothesis={h}
              onGraduate={handleGraduate}
              onReject={handleReject}
            />
          ))}
        </div>
      )}

      <div className="text-[12px] text-ink-3 mono pt-2 border-t border-line-1">
        source: MEMORY/WISDOM/FRAMES/_hypotheses/ · api: /api/hypotheses ·
        deriver: launchd com.lifeos.deriver
      </div>
    </PageShell>
  );
}
