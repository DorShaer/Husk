#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { loadAllManifests, resolveSources } from "../lib/manifest-loader";
import { getProvenance } from "../lib/frontmatter";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose") || args.includes("-v");
const failOnMissing = !args.includes("--lenient");

const manifests = loadAllManifests();
const seenFiles = new Set<string>();
const issues: { file: string; problem: string }[] = [];

console.log(`Auditing provenance across ${manifests.length} manifest(s)…\n`);

for (const m of manifests) {
  const sources = resolveSources(m);
  for (const s of sources) {
    if (seenFiles.has(s)) continue;
    seenFiles.add(s);
    if (!existsSync(s)) {
      issues.push({ file: s, problem: "missing" });
      continue;
    }
    if (s.endsWith(".json")) continue;
    const prov = getProvenance(s);
    if (verbose) console.log(`  ${prov.padEnd(11)} ${s}`);
    if (prov === "unknown" && failOnMissing) {
      issues.push({ file: s, problem: "no `provenance:` frontmatter (treated as customized for releases)" });
    }
  }
}

console.log(`\nScanned ${seenFiles.size} unique source file(s).`);
if (issues.length === 0) {
  console.log("✓ all sources have explicit provenance");
  process.exit(0);
}

console.error(`\n✗ ${issues.length} issue(s):`);
for (const i of issues) console.error(`  ${i.file} → ${i.problem}`);
process.exit(failOnMissing ? 1 : 0);
