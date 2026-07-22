import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hashFile(absPath: string): string {
  return sha256Hex(readFileSync(absPath, "utf8"));
}

export function fileMTimeMs(absPath: string): number {
  return statSync(absPath).mtimeMs;
}

export function combineSourceHashes(perFile: Record<string, string>, adapterVersion: string, model: string, schemaVersion: string): string {
  const sortedKeys = Object.keys(perFile).sort();
  const parts = sortedKeys.map((k) => `${k}:${perFile[k]}`);
  parts.push(`adapter:${adapterVersion}`);
  parts.push(`model:${model}`);
  parts.push(`schema:${schemaVersion}`);
  return sha256Hex(parts.join("|"));
}
