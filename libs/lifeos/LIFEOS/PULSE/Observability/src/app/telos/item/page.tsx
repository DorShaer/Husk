"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTelosData } from "../_v7/use-telos-data";
import type { Telos } from "../_v7/data";

// Per-item detail page. One static route (/telos/item) reads ?id=<ID> from the
// query — static-export safe, no generateStaticParams needed. Reuses the same
// useTelosData hook the dashboard uses, finds the item across every primitive
// array, and renders its fields plus relationships as links to other items.

interface Relation {
  label: string;
  ids: readonly string[];
}

interface ItemDetail {
  kind: string;
  id: string;
  title: string;
  summary?: string;
  body?: string;
  facts: Array<{ k: string; v: string }>;
  relations: Relation[];
}

function findItem(telos: Telos, id: string): ItemDetail | null {
  const d = telos.dimensions.find((x) => x.id === id);
  if (d)
    return {
      kind: "Ideal State",
      id,
      title: d.label,
      facts: [
        { k: "current", v: String(d.cur) },
        { k: "ideal", v: String(d.ideal) },
        { k: "velocity", v: `${d.velo}/mo` },
      ],
      relations: [],
    };

  const p = telos.problems.find((x) => x.id === id);
  if (p)
    return {
      kind: "Problem",
      id,
      title: p.title,
      summary: p.summary,
      body: p.note,
      facts: [{ k: "severity", v: p.severity }],
      relations: [{ label: "affects", ids: p.affects }],
    };

  const m = telos.missions.find((x) => x.id === id);
  if (m)
    return {
      kind: "Mission",
      id,
      title: m.title,
      summary: m.summary,
      facts: [{ k: "horizon", v: m.horizon }],
      relations: [{ label: "addresses", ids: m.addresses ?? [] }],
    };

  const g = telos.goals.find((x) => x.id === id);
  if (g)
    return {
      kind: "Goal",
      id,
      title: g.title,
      summary: g.summary,
      facts: [
        { k: "kpi", v: g.kpi },
        { k: "target", v: g.target },
        { k: "progress", v: `${g.pct}%` },
      ],
      relations: [
        { label: "dimensions", ids: g.dims },
        { label: "metrics", ids: g.metrics },
      ],
    };

  const mt = telos.metrics.find((x) => x.id === id);
  if (mt)
    return {
      kind: "Metric",
      id,
      title: mt.label,
      facts: [
        { k: "value", v: `${mt.value}${mt.unit}` },
        { k: "trend", v: String(mt.trend) },
      ],
      relations: [{ label: "feeds", ids: mt.feeds }],
    };

  const c = telos.challenges.find((x) => x.id === id);
  if (c)
    return {
      kind: "Challenge",
      id,
      title: c.title,
      summary: c.summary,
      body: c.note,
      facts: [],
      relations: [{ label: "blocks", ids: c.blocks }],
    };

  const s = telos.strategies.find((x) => x.id === id);
  if (s)
    return {
      kind: "Strategy",
      id,
      title: s.title,
      summary: s.summary,
      facts: [],
      relations: [
        { label: "overcomes", ids: s.overcomes },
        { label: "implements", ids: s.implements },
      ],
    };

  const pr = telos.projects.find((x) => x.id === id);
  if (pr)
    return {
      kind: "Project",
      id,
      title: pr.title,
      facts: [{ k: "status", v: pr.status }],
      relations: [
        { label: "strategy", ids: [pr.strategy] },
        { label: "dimensions", ids: pr.dims },
        { label: "work", ids: pr.work.map((w) => w.id) },
      ],
    };

  for (const proj of telos.projects) {
    const w = proj.work.find((x) => x.id === id);
    if (w)
      return {
        kind: "Work",
        id,
        title: w.title,
        facts: [
          { k: "status", v: w.status },
          { k: "eta", v: w.eta },
          { k: "owner", v: w.owner },
        ],
        relations: [
          { label: "strategy", ids: [w.strategy] },
          { label: "project", ids: [proj.id] },
        ],
      };
  }

  const t = telos.team.find((x) => x.id === id);
  if (t)
    return {
      kind: "Team",
      id,
      title: t.name,
      body: t.note,
      facts: [
        { k: "role", v: t.role },
        { k: "kind", v: t.kind },
      ],
      relations: [{ label: "owns", ids: t.owns }],
    };

  const b = telos.budget.find((x) => x.id === id);
  if (b)
    return {
      kind: "Budget",
      id,
      title: b.label,
      body: b.note,
      facts: [
        { k: "kind", v: b.kind },
        { k: "value", v: b.value },
        { k: "of", v: b.of },
        { k: "pct", v: `${b.pct}%` },
      ],
      relations: [{ label: "funds", ids: b.funds }],
    };

  const r = telos.recommendations.find((x) => x.id === id);
  if (r)
    return {
      kind: "Recommendation",
      id,
      title: r.action,
      body: r.because,
      facts: [
        { k: "effort", v: r.effort },
        { k: "impact", v: r.impact },
      ],
      relations: [{ label: "upstream", ids: r.upstream }],
    };

  return null;
}

function titleFor(telos: Telos, id: string): string {
  const hit = findItem(telos, id);
  return hit ? `${id} · ${hit.title}` : id;
}

function ItemView() {
  const sp = useSearchParams();
  const id = sp.get("id") ?? "";
  const { telos } = useTelosData();

  const item = telos ? findItem(telos, id) : null;

  return (
    <main className="telos-item">
      <nav className="telos-item-nav">
        <Link href="/telos" className="telos-item-back">← TELOS</Link>
      </nav>

      {!item ? (
        <div className="telos-item-empty">
          <p>
            No TELOS item with id <span className="mono">{id || "(none)"}</span>.
          </p>
          <Link href="/telos" className="telos-item-back">Back to TELOS</Link>
        </div>
      ) : (
        <article className="telos-item-card">
          <div className="telos-item-eyebrow">{item.kind}</div>
          <h1 className="telos-item-title">
            <span className="mono telos-item-id">{item.id}</span>
            {item.title}
          </h1>
          {item.summary && <p className="telos-item-summary">{item.summary}</p>}
          {item.body && <p className="telos-item-body">{item.body}</p>}

          {item.facts.length > 0 && (
            <dl className="telos-item-facts">
              {item.facts.map((f) => (
                <div key={f.k} className="telos-item-fact">
                  <dt>{f.k}</dt>
                  <dd className="mono">{f.v}</dd>
                </div>
              ))}
            </dl>
          )}

          {telos && item.relations.some((r) => r.ids.length > 0) && (
            <div className="telos-item-relations">
              {item.relations
                .filter((r) => r.ids.length > 0)
                .map((r) => (
                  <div key={r.label} className="telos-item-rel">
                    <span className="telos-item-rel-label">{r.label}</span>
                    <div className="telos-item-rel-chips">
                      {r.ids.map((rid) => (
                        <Link
                          key={rid}
                          href={`/telos/item?id=${encodeURIComponent(rid)}`}
                          className="telos-item-chip"
                        >
                          {titleFor(telos, rid)}
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </article>
      )}
    </main>
  );
}

export default function TelosItemPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: "var(--ink-1)" }}>Loading…</div>}>
      <ItemView />
    </Suspense>
  );
}
