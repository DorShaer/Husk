#!/usr/bin/env bun
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_PAGE_SCHEMAS, getSchemaByName, PageDataSchema } from "../Schema/PulseSchema";

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: bun ValidateSchema.ts <path-to-json> [--schema <name>]

Validates a JSON file against the Pulse Schema.

Default schema: PageDataSchema (the discriminated union — picks based on the file's "kind" field).
Override with --schema <name> where <name> is one of:
  ${Object.keys(ALL_PAGE_SCHEMAS).join("\n  ")}

Exit 0: valid. Exit 1: invalid (errors printed with field paths).`);
  process.exit(args.length === 0 ? 1 : 0);
}

const schemaIdx = args.findIndex((a) => a === "--schema");
const schemaName = schemaIdx >= 0 ? args[schemaIdx + 1] : "PageDataSchema";
const filePathIdx = args.findIndex((a) => !a.startsWith("--") && (schemaIdx < 0 || args.indexOf(a) !== schemaIdx + 1));
const filePath = filePathIdx >= 0 ? resolve(args[filePathIdx]!) : null;

if (!filePath) {
  console.error("error: missing path-to-json argument");
  process.exit(1);
}
if (!existsSync(filePath)) {
  console.error(`error: file not found: ${filePath}`);
  process.exit(1);
}

const schema = schemaName ? getSchemaByName(schemaName) : PageDataSchema;
if (!schema) {
  console.error(`error: unknown schema "${schemaName}". Run with --help for the list.`);
  process.exit(1);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(filePath, "utf8"));
} catch (e) {
  console.error(`error: file is not valid JSON: ${(e as Error).message}`);
  process.exit(1);
}

// If the file is a Data Plane wrapper {schemaVersion, data, _meta}, validate the inner data.
if (raw && typeof raw === "object" && "schemaVersion" in raw && "data" in raw && "_meta" in raw) {
  raw = (raw as { data: unknown }).data;
}

const result = schema.safeParse(raw);
if (result.success) {
  console.log(`✓ valid against ${schemaName}`);
  process.exit(0);
}

console.error(`✗ invalid against ${schemaName}:`);
for (const issue of result.error.issues) {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  console.error(`  ${path} → ${issue.message}`);
}
process.exit(1);
