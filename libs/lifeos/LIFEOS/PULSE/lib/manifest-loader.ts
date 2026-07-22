import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

export interface Manifest {
  id: string;
  title: string;
  dataType: string;
  sourceGlobs: string[];
  adapterPromptFile: string;
  model: string;
  rebuildButton: boolean;
  order: number;
  adapterVersion: string;
  staleAfterHours?: number;
}

const PULSE_ROOT = resolve((import.meta as unknown as { dir: string }).dir, "..");
const PAGES_DIR = resolve(PULSE_ROOT, "pages");
const LIFEOS_ROOT = resolve(PULSE_ROOT, "..", "..");

export function paiRoot(): string {
  return LIFEOS_ROOT;
}

export function pulseRoot(): string {
  return PULSE_ROOT;
}

export function pagesDir(): string {
  return PAGES_DIR;
}

function parseTomlValue(v: string): unknown {
  v = v.trim();
  if (v.startsWith("\"") && v.endsWith("\"")) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseTomlValue(s.trim()));
  }
  return v;
}

export function parseToml(content: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    out[key] = parseTomlValue(line.slice(eq + 1));
  }
  return out;
}

export function loadManifest(filePath: string): Manifest {
  const raw = parseToml(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  return {
    id: String(raw.id),
    title: String(raw.title),
    dataType: String(raw.dataType),
    sourceGlobs: (raw.sourceGlobs as string[]) ?? [],
    adapterPromptFile: String(raw.adapterPromptFile),
    model: String(raw.model),
    rebuildButton: Boolean(raw.rebuildButton),
    order: Number(raw.order),
    adapterVersion: String(raw.adapterVersion),
    staleAfterHours: typeof raw.staleAfterHours === "number" ? raw.staleAfterHours : undefined,
  };
}

export function loadAllManifests(): Manifest[] {
  if (!existsSync(PAGES_DIR)) return [];
  return readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith(".manifest.toml"))
    .map((f) => loadManifest(join(PAGES_DIR, f)))
    .sort((a, b) => a.order - b.order);
}

export function loadManifestById(id: string): Manifest | null {
  const manifests = loadAllManifests();
  return manifests.find((m) => m.id === id) ?? null;
}

function expandGlob(pattern: string): string[] {
  const abs = resolve(LIFEOS_ROOT, pattern);
  if (!pattern.includes("*")) {
    return existsSync(abs) ? [abs] : [];
  }
  const lastSlash = abs.lastIndexOf("/");
  const dir = abs.slice(0, lastSlash);
  const filePat = abs.slice(lastSlash + 1);
  if (!existsSync(dir)) return [];
  const re = new RegExp("^" + filePat.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f)).sort();
}

export function resolveSources(manifest: Manifest): string[] {
  const all: string[] = [];
  for (const g of manifest.sourceGlobs) {
    for (const p of expandGlob(g)) {
      if (!all.includes(p)) all.push(p);
    }
  }
  return all;
}
