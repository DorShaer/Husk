#!/usr/bin/env bun
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import { ALL_PAGE_SCHEMAS } from "../Schema/PulseSchema";

const PAGES_DIR = resolve((import.meta as unknown as { dir: string }).dir, "..", "pages");
const LIFEOS_ROOT = resolve((import.meta as unknown as { dir: string }).dir, "..", "..", "..");

const ManifestSchema = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab"),
  title: z.string().min(1),
  dataType: z.string().min(1),
  sourceGlobs: z.array(z.string().min(1)).min(1),
  adapterPromptFile: z.string().min(1),
  model: z.string().min(1),
  rebuildButton: z.boolean(),
  order: z.number().int(),
  adapterVersion: z.string().min(1),
  staleAfterHours: z.number().int().min(1).optional(),
});

type Manifest = z.infer<typeof ManifestSchema>;

interface Issue {
  manifest: string;
  field: string;
  message: string;
}

function parseToml(content: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const valStr = line.slice(eq + 1).trim();
    out[key] = parseTomlValue(valStr);
  }
  return out;
}

function parseTomlValue(v: string): unknown {
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

function checkSchemaTypeExists(typeName: string): boolean {
  return typeName in ALL_PAGE_SCHEMAS;
}

function checkPromptFileExists(promptFile: string): boolean {
  return existsSync(resolve(LIFEOS_ROOT, promptFile));
}

function main(): number {
  if (!existsSync(PAGES_DIR)) {
    console.error(`error: pages directory not found: ${PAGES_DIR}`);
    return 1;
  }

  const files = readdirSync(PAGES_DIR).filter((f) => f.endsWith(".manifest.toml"));
  if (files.length === 0) {
    console.error(`error: no *.manifest.toml files in ${PAGES_DIR}`);
    return 1;
  }

  const issues: Issue[] = [];
  const seenIds = new Map<string, string>();

  for (const file of files) {
    const fullPath = join(PAGES_DIR, file);
    let raw: Record<string, unknown>;
    try {
      raw = parseToml(readFileSync(fullPath, "utf8"));
    } catch (e) {
      issues.push({ manifest: file, field: "(parse)", message: (e as Error).message });
      continue;
    }

    const result = ManifestSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          manifest: file,
          field: issue.path.join(".") || "(root)",
          message: issue.message,
        });
      }
      continue;
    }

    const manifest = result.data as Manifest;

    const prevFile = seenIds.get(manifest.id);
    if (prevFile) {
      issues.push({
        manifest: file,
        field: "id",
        message: `duplicate id "${manifest.id}" — also in ${prevFile}`,
      });
    } else {
      seenIds.set(manifest.id, file);
    }

    if (!checkSchemaTypeExists(manifest.dataType)) {
      issues.push({
        manifest: file,
        field: "dataType",
        message: `unknown schema type "${manifest.dataType}" — not in ALL_PAGE_SCHEMAS`,
      });
    }

    if (!checkPromptFileExists(manifest.adapterPromptFile)) {
      issues.push({
        manifest: file,
        field: "adapterPromptFile",
        message: `prompt file not found: ${manifest.adapterPromptFile} (resolved against ${LIFEOS_ROOT})`,
      });
    }
  }

  console.log(`Scanned ${files.length} manifest(s) in ${PAGES_DIR}`);
  if (issues.length === 0) {
    console.log("✓ all manifests valid");
    return 0;
  }

  console.error(`\n✗ ${issues.length} issue(s):`);
  for (const issue of issues) {
    console.error(`  ${issue.manifest} → ${issue.field} → ${issue.message}`);
  }
  return 1;
}

process.exit(main());
