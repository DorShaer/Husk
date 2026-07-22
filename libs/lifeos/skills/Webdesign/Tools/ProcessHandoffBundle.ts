#!/usr/bin/env bun
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

type Frontmatter = Record<string, string>;
type Assets = {
  images: string[];
  fonts: string[];
  logos: string[];
  components: string[];
  code: string[];
  tokens: unknown | null;
  tokensError?: string;
  notes: string[];
  other: string[];
};
type Output = {
  bundleDir: string;
  promptFrontmatter: Frontmatter;
  promptBody: string;
  assets: Assets;
  summary: { totalFiles: number; categories: Record<string, number> };
};

const imageExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"]);
const fontExt = new Set([".woff", ".woff2", ".ttf", ".otf", ".eot"]);
const codeExt = new Set([".ts", ".js", ".mjs", ".cjs", ".css", ".scss", ".html"]);
const componentExt = new Set([".tsx", ".jsx", ".vue", ".svelte"]);
const noteNames = new Set(["README.md", "HANDOFF.md", "NOTES.md"]);

function parsePrompt(text: string): { frontmatter: Frontmatter; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text.trim() };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: text.trim() };
  const frontmatter: Frontmatter = {};
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    frontmatter[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: text.slice(end + 5).trim() };
}

async function walk(dir: string, root: string, depth = 0, acc: string[] = []): Promise<string[]> {
  if (depth > 6) return acc;
  if (acc.length > 5000) throw new Error("file-count-cap-exceeded");
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, root, depth + 1, acc);
    else if (entry.isFile()) {
      acc.push(relative(root, abs));
      if (acc.length > 5000) throw new Error("file-count-cap-exceeded");
    }
  }
  return acc;
}

function isUnder(rel: string, part: string): boolean {
  return rel.split(sep).includes(part);
}

function emptyAssets(): Assets {
  return { images: [], fonts: [], logos: [], components: [], code: [], tokens: null, notes: [], other: [] };
}

async function parseBundle(dir: string): Promise<Output> {
  const bundleDir = resolve(dir);
  const s = await stat(bundleDir).catch(() => null);
  if (!s?.isDirectory()) {
    console.log(JSON.stringify({ error: "no-such-bundle-dir", bundleDir }));
    process.exit(2);
  }
  const promptPath = join(bundleDir, "PROMPT.md");
  if (!(await Bun.file(promptPath).exists())) {
    console.log(JSON.stringify({ error: "no-prompt-md", bundleDir }));
    process.exit(2);
  }
  const prompt = parsePrompt(await Bun.file(promptPath).text());
  const files = await walk(bundleDir, bundleDir);
  const assets = emptyAssets();
  let tokenPath: string | null = null;
  for (const rel of files) {
    const name = basename(rel);
    const ext = extname(rel).toLowerCase();
    let caught = false;
    if (imageExt.has(ext)) {
      assets.images.push(rel);
      caught = true;
      if (/logo|mark|brand/i.test(name)) assets.logos.push(rel);
    }
    if (fontExt.has(ext)) {
      assets.fonts.push(rel);
      caught = true;
    }
    if (name === "tokens.json") {
      tokenPath = join(bundleDir, rel);
      caught = true;
    }
    if (isUnder(rel, "components") || componentExt.has(ext)) {
      assets.components.push(rel);
      caught = true;
    } else if (codeExt.has(ext)) {
      assets.code.push(rel);
      caught = true;
    }
    if (noteNames.has(name)) {
      assets.notes.push(rel);
      caught = true;
    }
    if (!caught && name !== "PROMPT.md") assets.other.push(rel);
  }
  if (tokenPath) {
    try {
      assets.tokens = JSON.parse(await readFile(tokenPath, "utf8")) as unknown;
    } catch (e) {
      assets.tokensError = e instanceof Error ? e.message : String(e);
    }
  }
  const categories: Record<string, number> = {};
  for (const key of ["images", "fonts", "logos", "components", "code", "notes", "other"]) {
    categories[key] = assets[key as keyof Pick<Assets, "images" | "fonts" | "logos" | "components" | "code" | "notes" | "other">].length;
  }
  categories.tokens = assets.tokens || assets.tokensError ? 1 : 0;
  return { bundleDir, promptFrontmatter: prompt.frontmatter, promptBody: prompt.body, assets, summary: { totalFiles: files.length, categories } };
}

async function renderBrief(out: Output): Promise<string> {
  const lines: string[] = [`# Handoff Bundle Brief: ${basename(out.bundleDir)}`, "", "## Prompt frontmatter"];
  const entries = Object.entries(out.promptFrontmatter);
  lines.push(...(entries.length ? entries.map(([k, v]) => `- ${k}: ${v}`) : ["- none"]));
  lines.push("", "## Contents");
  for (const key of ["images", "fonts", "logos", "components", "code", "notes", "other"] as const) {
    const list = out.assets[key];
    lines.push(`- ${list.length} ${key}${list.length ? ` (${list.slice(0, 10).join(", ")})` : ""}`);
  }
  lines.push(`- ${out.summary.categories.tokens} tokens`);
  lines.push("", "## Integration notes");
  const notes: string[] = [];
  for (const rel of out.assets.notes) notes.push(await readFile(join(out.bundleDir, rel), "utf8"));
  lines.push(notes.join("\n\n").trim() || "No notes files found.");
  lines.push("", "## Suggested next step", "Pass this bundle to the frontend build context with the following one-line instruction:");
  lines.push(`> Integrate the assets in \`${out.bundleDir}\` using \`tokens.json\` (if present) and components/ directory as the design reference.`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const [dir, flag] = Bun.argv.slice(2);
  if (!dir) {
    console.error("usage: ProcessHandoffBundle.ts <bundle-dir> [--brief]");
    return;
  }
  if (flag && flag !== "--brief") {
    console.error("usage: ProcessHandoffBundle.ts <bundle-dir> [--brief]");
    process.exit(2);
  }
  const out = await parseBundle(dir);
  console.log(flag === "--brief" ? await renderBrief(out) : JSON.stringify(out, null, 2));
}

await main();
