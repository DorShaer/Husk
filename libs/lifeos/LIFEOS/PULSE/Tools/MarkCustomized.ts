#!/usr/bin/env bun
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteText } from "../lib/atomic-write";
import { parseFrontmatter, serializeFrontmatter } from "../lib/frontmatter";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log("Usage: bun MarkCustomized.ts <path-to-md-file>\n\nSets frontmatter `provenance: customized` on the file.");
  process.exit(args.length === 0 ? 1 : 0);
}

const target = resolve(args[0]!);
if (!existsSync(target)) {
  console.error(`error: file not found: ${target}`);
  process.exit(1);
}

const fm = parseFrontmatter(readFileSync(target, "utf8"));
if (fm.data.provenance === "customized") {
  console.log(`already customized: ${target}`);
  process.exit(0);
}

const next = serializeFrontmatter({ ...fm.data, provenance: "customized", last_updated: new Date().toISOString().slice(0, 10) }, fm.body);
atomicWriteText(target, next);
console.log(`✓ marked customized: ${target}`);
