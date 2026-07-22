#!/usr/bin/env bun
/**
 * Render.ts — deterministic HTML-artifact renderer.
 *
 * Takes a typed content JSON + a design register name, emits ONE self-contained
 * HTML file: inline CSS, optional @font-face data-URIs from local font files,
 * zero external requests (Artifact-CSP safe).
 *
 * The model's job ends at the JSON. Layout, typography, color, spacing,
 * numbering — all deterministic in here.
 *
 * Usage:
 *   bun Render.ts --json content.json --register dossier --out artifact.html
 *   bun Render.ts --schema            # print the content schema + example
 *   bun Render.ts --registers        # list available registers
 *
 * Numbering rule: all numbers/labels are REAL DOM TEXT, never CSS counters —
 * DOM-render screenshot pipelines drop pseudo-element generated content.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------- content schema ----------

type Badge = string; // e.g. VERIFIED | REPORTED | FACT — free text, styled by class map
type Block =
  | { type: "prose"; html: string }
  | { type: "quote"; id?: string; badge?: Badge; quote?: string; text?: string; note?: string; source?: string }
  | { type: "list"; items: { lead: string; text: string }[] }
  | { type: "cut"; stamp: string; quote: string; note: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "callout"; html: string }
  | { type: "group"; label: string; detail?: string };

interface Section { title: string; intro?: string; blocks: Block[] }
interface Doc {
  title: string;            // page + masthead title; last word gets the accent if accentLastWord
  eyebrow?: string;
  subtitle?: string;
  accentLastWord?: boolean; // default true
  summary?: { label?: string; html: string };
  sections: Section[];
  footer?: string;
  numberedSections?: boolean; // default true — rendered as real text
}

// ---------- registers ----------

interface Register {
  name: string;
  vars: Record<string, string>;
  displayStack: string;   // CSS font-family for display
  bodyStack: string;
  monoStack: string;
  embedFonts: { family: string; files: string[] }[]; // first existing file wins; searched in fontDirs
  badgeSolid: string[];   // badges rendered solid-filled (others outlined)
}

const REGISTERS: Record<string, Register> = {
  dossier: {
    name: "dossier",
    vars: {
      ink: "#0d1712", panel: "#121f17", line: "#26382c",
      fg: "#f2ede2", dim: "#c6c0b1", accent: "#f58220", accent2: "#7d9fc4", danger: "#d0654a",
    },
    displayStack: "Anton, 'Arial Narrow', 'Avenir Next Condensed', sans-serif",
    bodyStack: "'Avenir Next', 'Helvetica Neue', system-ui, sans-serif",
    monoStack: "'Courier New', monospace",
    embedFonts: [{ family: "Anton", files: ["Anton-Regular.ttf"] }],
    badgeSolid: ["VERIFIED"],
  },
  ledger: {
    name: "ledger",
    vars: {
      ink: "#101623", panel: "#161e30", line: "#2a3550",
      fg: "#dce6f2", dim: "#9fb0c8", accent: "#d9a441", accent2: "#6fbf9f", danger: "#c96f6f",
    },
    displayStack: "'Iowan Old Style', 'Palatino', Georgia, serif",
    bodyStack: "'Avenir Next', 'Helvetica Neue', system-ui, sans-serif",
    monoStack: "'SF Mono', Menlo, 'Courier New', monospace",
    embedFonts: [],
    badgeSolid: ["VERIFIED", "CONFIRMED"],
  },
};

const FONT_DIRS = [join(homedir(), "Library/Fonts"), "/Library/Fonts", "/System/Library/Fonts/Supplemental"];

// ---------- helpers ----------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fontFace(reg: Register): string {
  let css = "";
  for (const f of reg.embedFonts) {
    for (const file of f.files) {
      const p = FONT_DIRS.map((d) => join(d, file)).find(existsSync);
      if (p) {
        const b64 = readFileSync(p).toString("base64");
        const fmt = file.endsWith(".otf") ? "opentype" : "truetype";
        css += `@font-face{font-family:'${f.family}';src:url(data:font/ttf;base64,${b64}) format('${fmt}');font-display:swap}\n`;
        break;
      }
    }
  }
  return css;
}

function css(reg: Register): string {
  const v = reg.vars;
  return `
${fontFace(reg)}
:root{--ink:${v.ink};--panel:${v.panel};--line:${v.line};--fg:${v.fg};--dim:${v.dim};--accent:${v.accent};--accent2:${v.accent2};--danger:${v.danger}}
html{background:var(--ink)}
body{background:var(--ink);color:var(--fg);font-family:${reg.bodyStack};line-height:1.6;font-size:16px;margin:0}
.page{max-width:760px;margin:0 auto;padding:64px 28px 80px}
.eyebrow{font-family:${reg.monoStack};font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:var(--accent);margin:0 0 14px}
h1{font-family:${reg.displayStack};font-weight:400;font-size:clamp(42px,9vw,72px);line-height:.98;text-transform:uppercase;margin:0 0 10px;text-wrap:balance}
h1 .acc{color:var(--accent)}
.subtitle{color:var(--dim);max-width:56ch;margin:0 0 40px}
h2{font-family:${reg.displayStack};font-weight:400;font-size:27px;text-transform:uppercase;letter-spacing:.02em;margin:54px 0 6px;text-wrap:balance}
h2 .n{color:var(--accent);font-family:${reg.monoStack};font-size:16px;margin-right:10px}
.rule{height:1px;background:var(--line);border:0;margin:0 0 20px}
.intro{color:var(--dim);max-width:60ch;margin:0 0 22px}
.slab{background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--accent);padding:22px 26px;margin:0 0 8px}
.slab p{margin:0}
.slab b,.slab strong{color:var(--accent)}
.callout{background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--accent2);padding:20px 24px;margin:14px 0}
.callout p{margin:0 0 10px}.callout p:last-child{margin:0}
.group{font-family:${reg.monoStack};font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--dim);margin:28px 0 6px}
.group b{color:var(--fg)}
.ex{display:grid;grid-template-columns:74px 1fr;gap:18px;border-top:1px solid var(--line);padding:17px 0}
.ex:last-child{border-bottom:1px solid var(--line)}
.ex .id{font-family:${reg.monoStack};font-size:12px;letter-spacing:.08em;color:var(--accent);padding-top:3px}
.ex .id .badge{display:inline-block;margin-top:6px}
.badge{font-family:${reg.monoStack};font-size:10px;letter-spacing:.12em;padding:2px 6px;color:var(--dim);border:1px solid var(--dim);border-radius:2px}
.badge.solid{background:var(--accent);color:var(--ink);border-color:var(--accent);font-weight:700}
.ex p{margin:0 0 6px}
.ex .q{font-family:${reg.monoStack};font-size:14.5px}
.ex .q .om{color:var(--accent)}
.ex .src{font-size:12.5px;color:var(--dim)}
ul.lead{list-style:none;margin:0;padding:0}
ul.lead li{padding:13px 0;border-top:1px solid var(--line)}
ul.lead li:last-child{border-bottom:1px solid var(--line)}
ul.lead p{margin:0;font-size:15px;color:var(--dim)}
ul.lead b{color:var(--fg)}
.cut{display:grid;grid-template-columns:110px 1fr;gap:16px;padding:15px 0;border-top:1px solid var(--line)}
.cut:last-child{border-bottom:1px solid var(--line)}
.cut .stamp{font-family:${reg.monoStack};color:var(--danger);border:2px solid var(--danger);font-size:11px;letter-spacing:.14em;font-weight:700;padding:4px 6px;text-align:center;align-self:start;transform:rotate(-3deg)}
.cut .q{font-family:${reg.monoStack};font-size:14px;color:var(--dim);text-decoration:line-through;text-decoration-thickness:2px}
.cut p{margin:6px 0 0;font-size:13.5px;color:var(--dim)}
.tablewrap{overflow-x:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th{font-family:${reg.monoStack};font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);text-align:left;padding:8px 14px 8px 0;border-bottom:1px solid var(--fg)}
td{padding:9px 14px 9px 0;border-bottom:1px solid var(--line);vertical-align:top;font-variant-numeric:tabular-nums}
.prose{max-width:62ch}.prose p{margin:0 0 12px}
.foot{margin-top:52px;color:var(--dim);font-size:13px;border-top:1px solid var(--line);padding-top:16px}
@media(max-width:560px){.ex{grid-template-columns:1fr;gap:6px}.cut{grid-template-columns:1fr}.cut .stamp{justify-self:start}}
`.trim();
}

// ---------- block renderers (all numbering = real text) ----------

function renderBlock(b: Block, reg: Register): string {
  switch (b.type) {
    case "prose":
      return `<div class="prose">${b.html}</div>`;
    case "callout":
      return `<div class="callout">${b.html}</div>`;
    case "group":
      return `<p class="group"><b>${esc(b.label)}</b>${b.detail ? ` · ${esc(b.detail)}` : ""}</p>`;
    case "quote": {
      const badge = b.badge
        ? `<span class="badge${reg.badgeSolid.includes(b.badge.toUpperCase()) ? " solid" : ""}">${esc(b.badge)}</span>`
        : "";
      const id = b.id ? `${esc(b.id)}` : "";
      const body = b.quote
        ? `<p class="q"><span class="om">“</span>${esc(b.quote)}<span class="om">”</span></p>`
        : "";
      const text = b.text ? `<p>${b.text}</p>` : "";
      const note = b.note ? `<p class="src">${b.note}</p>` : "";
      const src = b.source ? `<p class="src">${b.source}</p>` : "";
      return `<div class="ex"><div class="id">${id}${badge ? `<span class="badge-wrap"></span>${badge}` : ""}</div><div>${body}${text}${note}${src}</div></div>`;
    }
    case "list":
      return `<ul class="lead">${b.items
        .map((i) => `<li><p><b>${esc(i.lead)}</b> ${i.text}</p></li>`)
        .join("")}</ul>`;
    case "cut":
      return `<div class="cut"><div class="stamp">${esc(b.stamp)}</div><div><span class="q">“${esc(b.quote)}”</span><p>${b.note}</p></div></div>`;
    case "table":
      return `<div class="tablewrap"><table><thead><tr>${b.headers
        .map((h) => `<th>${esc(h)}</th>`)
        .join("")}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`;
  }
}

function render(doc: Doc, reg: Register): string {
  const accent = doc.accentLastWord !== false;
  const words = doc.title.trim().split(/\s+/);
  const last = accent ? words.pop() : undefined;
  const h1 = `${esc(words.join(" "))}${last ? ` <span class="acc">${esc(last)}</span>` : ""}`;
  const numbered = doc.numberedSections !== false;

  const sections = doc.sections
    .map((s, i) => {
      const n = numbered ? `<span class="n">${String(i + 1).padStart(2, "0")}</span>` : "";
      return `<section><h2>${n}${esc(s.title)}</h2><hr class="rule">${
        s.intro ? `<p class="intro">${s.intro}</p>` : ""
      }${s.blocks.map((b) => renderBlock(b, reg)).join("\n")}</section>`;
    })
    .join("\n");

  return `<title>${esc(doc.title)}</title>
<style>
${css(reg)}
</style>
<div class="page">
${doc.eyebrow ? `<p class="eyebrow">${esc(doc.eyebrow)}</p>` : ""}
<h1>${h1}</h1>
${doc.subtitle ? `<p class="subtitle">${doc.subtitle}</p>` : ""}
${doc.summary ? `<div class="slab">${doc.summary.label ? `<p class="eyebrow" style="margin-bottom:8px">${esc(doc.summary.label)}</p>` : ""}<p>${doc.summary.html}</p></div>` : ""}
${sections}
${doc.footer ? `<p class="foot">${doc.footer}</p>` : ""}
</div>
`;
}

// ---------- CLI ----------

const EXAMPLE: Doc = {
  title: "Never a Liberal?",
  eyebrow: "A red team of one claim · evidence brief",
  subtitle: "The claim under test, with verbatim sourced quotes both ways.",
  summary: { label: "Verdict", html: "<b>False on the letter.</b> Survives only as a definitional argument." },
  sections: [
    {
      title: "The evidence",
      blocks: [
        { type: "group", label: "Early years", detail: "1975–1982" },
        { type: "quote", id: "E1", badge: "VERIFIED", quote: "An example verbatim quote.", source: "Source, date" },
        { type: "list", items: [{ lead: "Lead-in.", text: "Supporting sentence." }] },
        { type: "cut", stamp: "UNVERIFIED", quote: "A famous quote that failed verification.", note: "Why it was cut." },
      ],
    },
  ],
  footer: "Method note.",
};

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

if (args.includes("--schema")) {
  console.log(JSON.stringify(EXAMPLE, null, 2));
  process.exit(0);
}
if (args.includes("--registers")) {
  console.log(Object.keys(REGISTERS).join("\n"));
  process.exit(0);
}

const jsonPath = flag("json");
const regName = flag("register") ?? "dossier";
const out = flag("out") ?? "artifact.html";
if (!jsonPath) {
  console.error("Usage: bun Render.ts --json <content.json> [--register dossier|ledger] [--out artifact.html]\n       bun Render.ts --schema | --registers");
  process.exit(2);
}
const reg = REGISTERS[regName];
if (!reg) {
  console.error(`Unknown register "${regName}". Available: ${Object.keys(REGISTERS).join(", ")}`);
  process.exit(2);
}
const doc: Doc = JSON.parse(readFileSync(jsonPath, "utf8"));
if (!doc.title || !Array.isArray(doc.sections)) {
  console.error("Content JSON must have at least { title, sections[] }. Run --schema for an example.");
  process.exit(2);
}
const html = render(doc, reg);
writeFileSync(out, html);
console.log(`${out} (${Math.round(html.length / 1024)}KB, register=${reg.name}, fonts=${reg.embedFonts.map((f) => f.family).join("+") || "system"})`);
