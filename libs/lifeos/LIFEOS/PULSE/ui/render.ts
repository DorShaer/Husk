import { type, space, radius, motion, layout, cssVars, type Mode } from "./Theme";
import type { CollectionPage, NarrativePage, ReferencePage, IndexPage, PageData } from "../Schema/PulseSchema";
import type { DataPlaneIndex } from "../lib/data-plane";

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function mdInline(s: string): string {
  return escape(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function mdBlock(s: string): string {
  const lines = s.split("\n");
  let html = "", inUl = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[-*]\s/.test(line)) {
      if (!inUl) { html += "<ul>"; inUl = true; }
      html += `<li>${mdInline(line.replace(/^[-*]\s/, ""))}</li>`;
    } else {
      if (inUl) { html += "</ul>"; inUl = false; }
      if (line) html += `<p>${mdInline(line)}</p>`;
    }
  }
  if (inUl) html += "</ul>";
  return html;
}

export function baseStyles(mode: Mode): string {
  return `
    :root { ${cssVars(mode)} }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: var(--c-bg); color: var(--c-text); font-family: ${type.fontSans}; font-size: ${type.scale.base}; line-height: ${type.lineHeight.normal}; }
    a { color: var(--c-accent); text-decoration: none; }
    a:hover { color: var(--c-accentHover); text-decoration: underline; }
    code { font-family: ${type.fontMono}; font-size: 0.92em; background: var(--c-bgSubtle); padding: 0 ${space.xs}; border-radius: ${radius.sm}; }
    .layout { display: grid; grid-template-columns: ${layout.sidebarWidth} 1fr; min-height: 100vh; }
    header.app-header { grid-column: 1 / -1; height: ${layout.headerHeight}; background: var(--c-bgElevated); border-bottom: 1px solid var(--c-border); display: flex; align-items: center; padding: 0 ${space.xl}; gap: ${space.lg}; position: sticky; top: 0; z-index: 10; }
    header.app-header .brand { font-weight: ${type.weight.semibold}; font-size: ${type.scale.md}; letter-spacing: -0.01em; }
    header.app-header .meta { color: var(--c-textMuted); font-size: ${type.scale.sm}; margin-left: auto; }
    aside.sidebar { background: var(--c-bgElevated); border-right: 1px solid var(--c-border); padding: ${space.lg} 0; overflow-y: auto; }
    aside.sidebar nav { display: flex; flex-direction: column; gap: ${space.xs}; }
    aside.sidebar a.nav-item { color: var(--c-text); padding: ${space.sm} ${space.lg}; display: flex; align-items: center; gap: ${space.sm}; font-size: ${type.scale.sm}; transition: background ${motion.fast}; border-left: 2px solid transparent; }
    aside.sidebar a.nav-item:hover { background: var(--c-bgSubtle); text-decoration: none; }
    aside.sidebar a.nav-item.active { background: var(--c-bgSubtle); border-left-color: var(--c-accent); font-weight: ${type.weight.medium}; }
    .pill { display: inline-flex; align-items: center; padding: 1px ${space.sm}; border-radius: ${radius.pill}; font-size: ${type.scale.xs}; font-weight: ${type.weight.medium}; letter-spacing: 0.04em; text-transform: uppercase; }
    .pill.template { background: var(--c-pillTemplate); color: white; }
    .pill.customized { background: var(--c-pillCustomized); color: white; }
    main.content { padding: ${space.xxxl} ${space.xxl}; max-width: ${layout.contentMaxWidth}; margin: 0 auto; width: 100%; }
    main.content h1 { font-size: ${type.scale.xxl}; font-weight: ${type.weight.bold}; line-height: ${type.lineHeight.tight}; letter-spacing: -0.02em; margin-bottom: ${space.lg}; }
    main.content h2 { font-size: ${type.scale.xl}; font-weight: ${type.weight.semibold}; line-height: ${type.lineHeight.tight}; margin-top: ${space.xxxl}; margin-bottom: ${space.md}; letter-spacing: -0.015em; }
    main.content h3 { font-size: ${type.scale.lg}; font-weight: ${type.weight.semibold}; margin-top: ${space.xl}; margin-bottom: ${space.sm}; }
    main.content p { margin-bottom: ${space.md}; color: var(--c-text); }
    main.content ul, main.content ol { margin-left: ${space.xl}; margin-bottom: ${space.md}; }
    main.content li { margin-bottom: ${space.xs}; }
    .lede { font-size: ${type.scale.lg}; color: var(--c-textMuted); font-family: ${type.fontSerif}; line-height: ${type.lineHeight.snug}; margin-bottom: ${space.xxl}; }
    .pull-quote { font-family: ${type.fontSerif}; font-size: ${type.scale.lg}; font-style: italic; padding: ${space.lg} ${space.xl}; border-left: 3px solid var(--c-accent); margin: ${space.xl} 0; color: var(--c-text); background: var(--c-bgSubtle); }
    .meta-row { display: flex; align-items: center; gap: ${space.md}; margin-top: ${space.sm}; color: var(--c-textMuted); font-size: ${type.scale.sm}; }
    .stale-banner { background: var(--c-warn); color: white; padding: ${space.sm} ${space.lg}; border-radius: ${radius.md}; margin-bottom: ${space.lg}; font-size: ${type.scale.sm}; }
    .template-banner { background: var(--c-bgSubtle); border: 1px dashed var(--c-pillTemplate); padding: ${space.md} ${space.lg}; border-radius: ${radius.md}; margin-bottom: ${space.xl}; color: var(--c-text); font-size: ${type.scale.sm}; }
    .empty-state { padding: ${space.xxxl} ${space.lg}; text-align: center; color: var(--c-textMuted); }
    .empty-state h2 { color: var(--c-text); margin-bottom: ${space.md}; }
    .item-card { padding: ${space.md} ${space.lg}; border: 1px solid var(--c-border); border-radius: ${radius.md}; margin-bottom: ${space.sm}; background: var(--c-bgElevated); }
    .item-card .name { font-weight: ${type.weight.medium}; }
    .item-card .creator { color: var(--c-textMuted); margin-left: ${space.sm}; }
    .item-card .rating { color: var(--c-warn); margin-left: ${space.sm}; }
    .item-card .notes { color: var(--c-textMuted); margin-top: ${space.xs}; font-size: ${type.scale.sm}; }
    .ref-table { width: 100%; border-collapse: collapse; }
    .ref-table th, .ref-table td { padding: ${space.sm} ${space.md}; text-align: left; border-bottom: 1px solid var(--c-border); font-size: ${type.scale.sm}; }
    .ref-table th { font-weight: ${type.weight.semibold}; color: var(--c-textMuted); font-size: ${type.scale.xs}; text-transform: uppercase; letter-spacing: 0.04em; }
    .ref-table td.key { font-family: ${type.fontMono}; font-size: ${type.scale.sm}; color: var(--c-text); }
    .index-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: ${space.lg}; }
    .index-tile { padding: ${space.lg}; border: 1px solid var(--c-border); border-radius: ${radius.lg}; background: var(--c-bgElevated); }
    .index-tile h3 { margin: 0 0 ${space.xs} 0; }
    .index-tile .preview { color: var(--c-textMuted); font-size: ${type.scale.sm}; }
    button.rebuild-btn { background: var(--c-bgElevated); border: 1px solid var(--c-border); color: var(--c-text); padding: ${space.sm} ${space.md}; border-radius: ${radius.md}; cursor: pointer; font-size: ${type.scale.sm}; transition: all ${motion.fast}; }
    button.rebuild-btn:hover { background: var(--c-bgSubtle); border-color: var(--c-accent); }
    button.rebuild-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
    .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: ${space.lg}; margin-bottom: ${space.xl}; }
    .page-header .actions { display: flex; gap: ${space.sm}; }
  `;
}

export function renderShell(opts: {
  mode: Mode;
  pageId: string;
  pageTitle: string;
  index: DataPlaneIndex | null;
  body: string;
}): string {
  const { mode, pageId, pageTitle, index, body } = opts;
  const navItems = (index?.pages ?? [])
    .map((e) => {
      const active = e.id === pageId ? "active" : "";
      const pill = e.provenance === "template" ? `<span class="pill template">template</span>` : "";
      return `<a class="nav-item ${active}" href="/v2/${escape(e.id)}">${escape(e.title)} ${pill}</a>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pulse | ${escape(pageTitle)}</title>
<style>${baseStyles(mode)}</style>
</head>
<body>
<div class="layout">
  <header class="app-header">
    <span class="brand">Pulse</span>
    <span class="meta">${index ? `${index.pages.length} pages · last build ${escape(index.generatedAt.slice(0, 16))}` : "no index yet"}</span>
  </header>
  <aside class="sidebar">
    <nav>${navItems}</nav>
  </aside>
  <main class="content">
    ${body}
  </main>
</div>
</body>
</html>`;
}

export function renderEmpty(pageId: string, message: string): string {
  return `<div class="empty-state"><h2>${escape(pageId)} — no data yet</h2><p>${escape(message)}</p></div>`;
}

export function renderTemplateBanner(): string {
  return `<div class="template-banner">📝 This page is on template defaults — customize it by editing the underlying USER/ file.</div>`;
}

export function renderStaleBanner(ageHours: number): string {
  return `<div class="stale-banner">⏰ Data is stale (${Math.round(ageHours)}h old). Click Rebuild to refresh.</div>`;
}

function renderHeader(title: string, pageId: string, rebuildable: boolean, isTemplate: boolean): string {
  const pill = isTemplate ? `<span class="pill template">template</span>` : "";
  const btn = rebuildable ? `<button class="rebuild-btn" onclick="fetch('/api/pulse/rebuild/${escape(pageId)}',{method:'POST'}).then(()=>location.reload())">🔄 Rebuild</button>` : "";
  return `<div class="page-header"><div><h1>${escape(title)} ${pill}</h1></div><div class="actions">${btn}</div></div>`;
}

export function renderCollection(p: CollectionPage, opts: { rebuildable: boolean }): string {
  const isTemplate = p.meta.provenance === "template";
  const items = p.items.length === 0
    ? `<div class="empty-state"><h2>No items yet</h2><p>${escape(p.title)} is empty. Add entries to your USER/ source file.</p></div>`
    : p.items.map((it) => {
        const creator = it.creator ? `<span class="creator">— ${escape(it.creator)}</span>` : "";
        const rating = it.rating ? `<span class="rating">★${it.rating}</span>` : "";
        const notes = it.notes ? `<div class="notes">${mdInline(it.notes)}</div>` : "";
        const priv = it.private ? ` <span class="pill template">private</span>` : "";
        return `<div class="item-card"><span class="name">${escape(it.name)}</span>${creator}${rating}${priv}${notes}</div>`;
      }).join("\n");
  return [
    renderHeader(p.title, p.meta.pageId, opts.rebuildable, isTemplate),
    isTemplate ? renderTemplateBanner() : "",
    p.description ? `<p class="lede">${mdInline(p.description)}</p>` : "",
    items,
  ].filter(Boolean).join("\n");
}

export function renderNarrative(p: NarrativePage, opts: { rebuildable: boolean }): string {
  const isTemplate = p.meta.provenance === "template";
  const sections = p.sections.length === 0
    ? `<div class="empty-state"><h2>No content yet</h2><p>${escape(p.title)} has no narrative sections. Customize the source file.</p></div>`
    : p.sections.map((s) => `<h${s.level}>${escape(s.heading)}</h${s.level}>${mdBlock(s.body)}`).join("\n");
  const quotes = p.pullQuotes.map((q) => `<blockquote class="pull-quote">${escape(q)}</blockquote>`).join("\n");
  return [
    renderHeader(p.title, p.meta.pageId, opts.rebuildable, isTemplate),
    isTemplate ? renderTemplateBanner() : "",
    p.lede ? `<p class="lede">${mdInline(p.lede)}</p>` : "",
    sections,
    quotes,
  ].filter(Boolean).join("\n");
}

export function renderReference(p: ReferencePage, opts: { rebuildable: boolean }): string {
  const isTemplate = p.meta.provenance === "template";
  const grouped = new Map<string, typeof p.entries>();
  for (const e of p.entries) {
    const g = e.group ?? "";
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push(e);
  }
  const tables = p.entries.length === 0
    ? `<div class="empty-state"><h2>No entries</h2></div>`
    : Array.from(grouped.entries()).map(([g, entries]) => {
        const heading = g ? `<h2>${escape(g)}</h2>` : "";
        const rows = entries.map((e) => {
          const notes = e.notes ? `<td class="notes">${escape(e.notes)}</td>` : "<td></td>";
          return `<tr><td class="key">${escape(e.key)}</td><td>${escape(e.value)}</td>${notes}</tr>`;
        }).join("");
        return `${heading}<table class="ref-table"><thead><tr><th>Key</th><th>Value</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
      }).join("\n");
  return [
    renderHeader(p.title, p.meta.pageId, opts.rebuildable, isTemplate),
    isTemplate ? renderTemplateBanner() : "",
    p.description ? `<p class="lede">${mdInline(p.description)}</p>` : "",
    tables,
  ].filter(Boolean).join("\n");
}

export function renderIndex(p: IndexPage, opts: { rebuildable: boolean }): string {
  const isTemplate = p.meta.provenance === "template";
  const tiles = p.children.length === 0
    ? `<div class="empty-state"><h2>No children indexed</h2></div>`
    : `<div class="index-grid">${p.children.map((c) => `<a class="index-tile" href="${escape(c.path)}"><h3>${escape(c.title)}</h3>${c.preview ? `<div class="preview">${escape(c.preview)}</div>` : ""}</a>`).join("\n")}</div>`;
  return [
    renderHeader(p.title, p.meta.pageId, opts.rebuildable, isTemplate),
    isTemplate ? renderTemplateBanner() : "",
    p.description ? `<p class="lede">${mdInline(p.description)}</p>` : "",
    tiles,
  ].filter(Boolean).join("\n");
}

export function renderPage(p: PageData, opts: { rebuildable: boolean }): string {
  switch (p.kind) {
    case "collection": return renderCollection(p, opts);
    case "narrative": return renderNarrative(p, opts);
    case "reference": return renderReference(p, opts);
    case "index": return renderIndex(p, opts);
  }
}

