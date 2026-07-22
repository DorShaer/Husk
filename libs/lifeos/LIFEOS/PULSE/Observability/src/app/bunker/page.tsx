"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PageShell, PageHeader, Panel, PanelHeader, Pill, EmptyState, type Dim } from "@/components/ui/chrome";
import { Container } from "lucide-react";

// ── Bunker: the application-harness readout. Each app is a bay with ISA probes. ──

interface Probe { isc: string; check: string; status: string; detail: string }
interface App {
  name: string; type: string; dir: string; isaPath: string;
  pass: number; fail: number; skip: number; og: boolean; favicon: boolean; probes: Probe[];
}
interface Snapshot {
  apps: App[];
  summary: { apps: number; green: number; probesPass: number; probesTotal: number; manual: number };
  lastFetch: string | null;
}

function st(a: App): "ok" | "down" | "idle" {
  const total = a.pass + a.fail;
  if (total === 0) return "idle";
  return a.fail > 0 ? "down" : "ok";
}
// app/probe status → design-token dimension. ok=ok, down=err, idle=warn.
const stDim = (s: string): Dim => (s === "ok" ? "ok" : s === "down" ? "err" : "warn");
const dimVar = (d: Dim): string => `var(--${d === "blue" ? "accent-blue" : d === "neutral" ? "ink-3" : d})`;

function planesForType(type: string): { plane: string; components: { name: string; live: boolean }[] }[] {
  const harness = { name: "test-harness", live: true };
  const health = { name: "health", live: true };
  const config = { name: "config + isa", live: true };
  if (type === "web-static") {
    return [
      { plane: "OBSERVABILITY", components: [{ name: "tracking (ul-admin)", live: false }, health, { name: "cost", live: false }] },
      { plane: "DELIVERY", components: [{ name: "deploy (workers)", live: false }, { name: "brand assets", live: true }, { name: "link-gate", live: false }] },
      { plane: "QUALITY", components: [harness] },
      { plane: "CONTROL", components: [config, { name: "type playbook", live: false }] },
      { plane: "IDENTITY", components: [{ name: "auth", live: false }, { name: "user/auth logs", live: false }] },
      { plane: "SECURITY", components: [{ name: "secrets / scanning / headers", live: false }] },
    ];
  }
  return [
    { plane: "QUALITY", components: [harness] },
    { plane: "OBSERVABILITY", components: [health, { name: "metrics", live: false }] },
    { plane: "CONTROL", components: [config, { name: "type playbook", live: false }] },
  ];
}

export default function BunkerPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch("/api/bunker", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      setData(await r.json());
      setError(null);
    } catch (e) { setError(String(e)); }
  };
  useEffect(() => { load(); const id = setInterval(load, 60_000); return () => clearInterval(id); }, []);

  const app = data?.apps.find((a) => a.name === selected) ?? null;

  return (
    <PageShell>
      <PageHeader
        icon={Container}
        title="Bunker"
        subtitle="Universal application harness · discovery-based registry · the harness speaks ISA"
        actions={
          <>
            <Pill dim="ok">
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ok)", animation: "pulse 2s ease-in-out infinite" }} />
              SYSTEMS ONLINE
            </Pill>
            {data && (
              <Pill dim={data.summary.probesPass === data.summary.probesTotal ? "ok" : "warn"}>
                {data.summary.apps} APPS · {data.summary.probesPass}/{data.summary.probesTotal} ✓
              </Pill>
            )}
          </>
        }
      />

      {error && (
        <Panel style={{ borderLeftWidth: 2, borderLeftColor: "var(--err)" }}>
          <span style={{ color: "var(--err)" }}>SIGNAL LOST · /api/bunker — {error}</span>
        </Panel>
      )}
      {!data && !error && <EmptyState title="Establishing link…" />}

      {data && !app && <Bays data={data} onOpen={setSelected} />}
      {data && app && <Readout app={app} onBack={() => setSelected(null)} />}

      {data && (
        <div className="text-[11px] tracking-[0.12em] text-ink-3">
          {data.lastFetch ? `LAST SCAN ${new Date(data.lastFetch).toLocaleTimeString()} · ` : ""}discovery-based registry
        </div>
      )}
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
    </PageShell>
  );
}

function Thumb({ app, w, h }: { app: App; w: number; h: number }) {
  const [broken, setBroken] = useState(false);
  if (app.og && !broken) {
    return (
      <img
        src={`/api/bunker/asset?app=${encodeURIComponent(app.name)}&kind=og`}
        alt={app.name}
        onError={() => setBroken(true)}
        className="border border-line-2"
        style={{ width: w, height: h, objectFit: "cover", borderRadius: 3, flex: "none", background: "var(--ground)" }}
      />
    );
  }
  return (
    <div
      className="border border-line-2 text-ink-3"
      style={{ width: w, height: h, borderRadius: 3, flex: "none", background: "var(--ground)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: h > 60 ? 22 : 13 }}
    >
      {app.type === "cli" ? "›_" : app.name.slice(0, 2).toUpperCase()}
    </div>
  );
}

function Bays({ data, onOpen }: { data: Snapshot; onOpen: (n: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <PanelHeader title={`Application Bays (${data.apps.length})`} />
      {data.apps.map((a) => {
        const dim = stDim(st(a));
        const c = dimVar(dim);
        const total = a.pass + a.fail;
        const pct = total === 0 ? 0 : Math.round((a.pass / total) * 100);
        return (
          <Panel
            key={a.name}
            hover
            onClick={() => onOpen(a.name)}
            className="flex flex-row items-center gap-4 cursor-pointer"
            style={{ borderLeftWidth: 2, borderLeftColor: c }}
          >
            <Thumb app={a} w={132} h={70} />
            <div className="flex flex-col gap-1.5 min-w-0 flex-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: c, flex: "none" }} />
                <span className="text-ink-1" style={{ fontSize: 16, fontWeight: 700, letterSpacing: "0.02em" }}>{a.name}</span>
                <Pill dim="neutral">{a.type.toUpperCase()}</Pill>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="bg-surface-1 rounded-[3px] overflow-hidden" style={{ height: 5, width: 180, maxWidth: "40vw", flex: "none" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: c }} />
                </div>
                <span style={{ fontSize: 12, color: c, letterSpacing: "0.06em" }}>{total === 0 ? "NO PROBES" : `${a.pass}/${total}`}</span>
              </div>
            </div>
            <span className="text-ink-3" style={{ fontSize: 12, letterSpacing: "0.14em", flex: "none" }}>OPEN ▸</span>
          </Panel>
        );
      })}
      <Panel className="border-dashed text-ink-3 text-[12px] tracking-[0.1em]">+ ADOPT AN APP · bunker adopt &lt;dir&gt;</Panel>
    </div>
  );
}

function Readout({ app, onBack }: { app: App; onBack: () => void }) {
  const dim = stDim(st(app));
  const c = dimVar(dim);
  const total = app.pass + app.fail;
  const pct = total === 0 ? 0 : Math.round((app.pass / total) * 100);

  return (
    <div className="flex flex-col gap-3.5">
      <button onClick={onBack} className="self-start text-[12px] tracking-[0.14em] cursor-pointer" style={{ background: "none", border: "none", color: "var(--accent-blue)", padding: 0 }}>◂ ALL BAYS</button>

      {app.og && <Thumb app={app} w={1120} h={168} />}

      <div className="flex items-center gap-3 flex-wrap">
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: c, flex: "none" }} />
        <span className="text-ink-1" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "0.04em" }}>{app.name}</span>
        <Pill dim="neutral">{app.type.toUpperCase()}</Pill>
        <span style={{ fontSize: 13, color: c, letterSpacing: "0.08em" }}>{total === 0 ? "NO PROBES" : `${app.pass}/${total} · ${pct}%`}</span>
      </div>

      <RPanel title="Test Harness · ISA Criteria & Probes" live>
        {app.probes.map((p) => {
          const pd = stDim(p.status === "pass" ? "ok" : p.status === "fail" ? "down" : "idle");
          const pc = dimVar(pd);
          const tag = p.status === "pass" ? "[OK]" : p.status === "fail" ? "[XX]" : "[--]";
          return (
            <div key={p.isc} className="flex items-center gap-3 border-b border-line-1" style={{ padding: "6px 0", fontSize: 13 }}>
              <span style={{ color: pc, flex: "none", width: 34 }} className="mono">{tag}</span>
              <span className="text-ink-3 mono" style={{ flex: "none", width: 52 }}>{p.isc}</span>
              <span className="text-ink-1 flex-1 min-w-0">{p.check}</span>
              <span className="text-ink-3" style={{ flex: "none" }}>{p.detail}</span>
            </div>
          );
        })}
      </RPanel>

      <RPanel title="Components · Six Planes" live>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", columnGap: 34, rowGap: 16 }}>
          {planesForType(app.type).map((pl) => (
            <div key={pl.plane}>
              <div className="text-[10px] tracking-[0.2em] mb-1.5" style={{ color: "var(--accent-blue)" }}>{pl.plane}</div>
              {pl.components.map((cp) => (
                <div key={cp.name} className="flex items-center gap-2" style={{ padding: "2px 0", fontSize: 13 }}>
                  <span style={{ width: 5, height: 5, borderRadius: "50%", background: cp.live ? "var(--ok)" : "var(--ink-3)", flex: "none" }} />
                  <span className="text-ink-2 flex-1 min-w-0">{cp.name}</span>
                  <span style={{ fontSize: 9, letterSpacing: "0.1em", color: cp.live ? "var(--ok)" : "var(--warn)", flex: "none" }}>{cp.live ? "LIVE" : "PENDING"}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </RPanel>

      <RPanel title="Live Metrics" live={false}>
        <p className="text-ink-3" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
          NOT WIRED. Planned: UL-admin tracking + a real-time viewers badge for this app, pageviews, per-app cloud cost. No fake numbers here.
        </p>
      </RPanel>
      <RPanel title="Identity & Logs" live={false}>
        <p className="text-ink-3" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
          {app.type === "web-enterprise" ? "Auth: OIDC (planned)." : "Auth: none for this type."} User + auth logs sink: pending.
        </p>
      </RPanel>
      <RPanel title="Source" live>
        <div className="text-ink-3" style={{ fontSize: 12, lineHeight: 1.7 }} data-sensitive>
          <div>type&nbsp;&nbsp; {app.type}</div>
          <div>dir&nbsp;&nbsp;&nbsp;&nbsp; {app.dir}</div>
          <div>isa&nbsp;&nbsp;&nbsp;&nbsp; {app.isaPath}</div>
        </div>
      </RPanel>
    </div>
  );
}

function RPanel({ title, live, children }: { title: string; live: boolean; children: ReactNode }) {
  return (
    <Panel style={{ borderLeftWidth: 2, borderLeftColor: live ? "var(--ok)" : "var(--warn)" }}>
      <PanelHeader
        title={title}
        actions={<Pill dim={live ? "ok" : "warn"}>{live ? "LIVE" : "PENDING"}</Pill>}
      />
      {children}
    </Panel>
  );
}
