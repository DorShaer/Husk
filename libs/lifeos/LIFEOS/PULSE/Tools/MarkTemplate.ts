#!/usr/bin/env bun
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteText } from "../lib/atomic-write";
import { parseFrontmatter, serializeFrontmatter } from "../lib/frontmatter";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log("Usage: bun MarkTemplate.ts <path-to-md-file>\n\nSets frontmatter `provenance: template`. Use sparingly — typically when wiping personal data to re-test scaffolding.");
  process.exit(args.length === 0 ? 1 : 0);
}

const target = resolve(args[0]!);
if (!existsSync(target)) {
  console.error(`error: file not found: ${target}`);
  process.exit(1);
}

const fm = parseFrontmatter(readFileSync(target, "utf8"));
if (fm.data.provenance === "template") {
  console.log(`already template: ${target}`);
  process.exit(0);
}

console.warn(`⚠ flipping ${target} from "${fm.data.provenance ?? "unknown"}" → "template"`);
console.warn(`  this should only be done when the file content is intentionally generic.`);

const next = serializeFrontmatter({ ...fm.data, provenance: "template" }, fm.body);
atomicWriteText(target, next);
console.log(`✓ marked template: ${target}`);
