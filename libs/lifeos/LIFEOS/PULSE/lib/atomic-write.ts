import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function atomicWriteJSON(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8" });
  renameSync(tmp, filePath);
}

export function atomicWriteText(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, { encoding: "utf8" });
  renameSync(tmp, filePath);
}
