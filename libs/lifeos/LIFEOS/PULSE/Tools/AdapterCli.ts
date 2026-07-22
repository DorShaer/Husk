#!/usr/bin/env bun
import { loadManifestById, loadAllManifests } from "../lib/manifest-loader";
import { runAdapter } from "../adapters/AdapterRunner";
import { readPage, writeIndex, type IndexEntry } from "../lib/data-plane";

const args = process.argv.slice(2);
const force = args.includes("--force");
const idArg = args.find((a) => !a.startsWith("--"));

if (!idArg || args.includes("--help")) {
  console.log("Usage: bun AdapterCli.ts <page-id> [--force]\n\nAvailable pages:");
  for (const m of loadAllManifests()) console.log(`  ${m.id} — ${m.title}`);
  process.exit(idArg ? 0 : 1);
}

const manifest = loadManifestById(idArg);
if (!manifest) {
  console.error(`error: no manifest with id "${idArg}"`);
  process.exit(1);
}

const result = await runAdapter(manifest, { force });

// Refresh _index.json so the Pulse v2 sidebar reflects the new state.
const all = loadAllManifests();
const entries: IndexEntry[] = all.map((m) => {
  const file = readPage(m.id);
  return {
    id: m.id,
    title: m.title,
    kind: m.dataType.replace("PageSchema", "").toLowerCase(),
    lastBuildAt: file?._meta.lastBuildAt ?? "",
    hasError: !file,
    costUSD: file?._meta.costUSD ?? 0,
    provenance: file?._meta.provenance ?? "template",
  };
});
writeIndex(entries);

console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "success" || result.status === "cached" ? 0 : 1);
