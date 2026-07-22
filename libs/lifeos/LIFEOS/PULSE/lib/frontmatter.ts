import { readFileSync } from "node:fs";

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  raw: string;
}

const FM_DELIM = "---";

export function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith(FM_DELIM)) {
    return { data: {}, body: content, raw: "" };
  }
  const lines = content.split("\n");
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FM_DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { data: {}, body: content, raw: "" };

  const fmLines = lines.slice(1, endIdx);
  const bodyLines = lines.slice(endIdx + 1);
  const data: Record<string, unknown> = {};

  for (const rawLine of fmLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (val.startsWith("\"") && val.endsWith("\"")) val = val.slice(1, -1);
    else if (val === "true") data[key] = true, void 0;
    else if (val === "false") data[key] = false, void 0;
    else if (/^-?\d+$/.test(val)) data[key] = parseInt(val, 10);
    else data[key] = val;
    if (typeof val === "string" && data[key] === undefined) data[key] = val;
  }

  return { data, body: bodyLines.join("\n"), raw: fmLines.join("\n") };
}

export function readFileWithFrontmatter(absPath: string): ParsedFrontmatter {
  return parseFrontmatter(readFileSync(absPath, "utf8"));
}

export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const sortedKeys = Object.keys(data).sort();
  const lines = [FM_DELIM];
  for (const k of sortedKeys) {
    const v = data[k];
    if (typeof v === "string") {
      const quoted = /[:#\-\[\]&*?{}|>%@`]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '\\"')}"` : v;
      lines.push(`${k}: ${quoted}`);
    } else if (typeof v === "boolean" || typeof v === "number") {
      lines.push(`${k}: ${v}`);
    } else if (v === null || v === undefined) {
      lines.push(`${k}: null`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push(FM_DELIM);
  return lines.join("\n") + "\n" + body;
}

export function getProvenance(absPath: string): "template" | "customized" | "unknown" {
  try {
    const fm = readFileWithFrontmatter(absPath);
    const v = fm.data.provenance;
    if (v === "template" || v === "customized") return v;
  } catch {
    /* fall through */
  }
  return "unknown";
}
