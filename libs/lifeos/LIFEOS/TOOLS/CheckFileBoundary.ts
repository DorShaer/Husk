#!/usr/bin/env bun
/**
 * CheckFileBoundary.ts — on-demand SystemFileGuard check.
 *
 * Wraps the same `evaluateWrite()` logic the runtime hook uses, but for use
 * in CI / pre-commit / ad-hoc audits. Reads a file's current content from
 * disk (or stdin) and reports whether it would be blocked if it were the
 * new content of a write to that path.
 *
 * Usage:
 *   bun LIFEOS/TOOLS/CheckFileBoundary.ts <file>           # check file on disk
 *   bun LIFEOS/TOOLS/CheckFileBoundary.ts <file> --stdin   # check content from stdin
 *   bun LIFEOS/TOOLS/CheckFileBoundary.ts --help
 *
 * Exit codes:
 *   0  -> allowed (USER zone, out-of-tree, or clean SYSTEM file)
 *   1  -> blocked (SYSTEM file with deny-list match)
 *   2  -> usage error
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { evaluateWrite } from "../../hooks/lib/system-file-guard-core";

function usage(code = 2): never {
  console.log(
    `CheckFileBoundary — boundary doctrine on-demand check\n\n` +
      `Usage:\n` +
      `  bun ${process.argv[1]} <file>          # check file content on disk\n` +
      `  bun ${process.argv[1]} <file> --stdin  # check content piped on stdin\n` +
      `  bun ${process.argv[1]} <dir>           # check every file in dir (recursive)\n` +
      `  bun ${process.argv[1]} --help\n\n` +
      `Exit: 0 allow / 1 blocked / 2 usage error.`,
  );
  process.exit(code);
}

function collectFiles(target: string): string[] {
  const st = statSync(target);
  if (st.isFile()) return [target];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(p);
    }
  };
  walk(target);
  return out;
}

function checkOne(absPath: string, content: string): boolean {
  const decision = evaluateWrite(absPath, content);
  if (!decision.block) {
    return true;
  }
  const hit = decision.hits[0]!;
  console.error(`BLOCK  ${decision.relPath}`);
  console.error(`       pattern: ${hit.pattern}`);
  console.error(`       match:   ${hit.match}`);
  return false;
}

function main(): never {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) usage(args.length === 0 ? 2 : 0);

  const fromStdin = args.includes("--stdin");
  const filtered = args.filter((a) => !a.startsWith("--"));
  if (filtered.length !== 1) usage(2);
  const targetRaw = filtered[0]!;
  const target = isAbsolute(targetRaw) ? targetRaw : resolve(process.cwd(), targetRaw);

  if (!existsSync(target)) {
    console.error(`CheckFileBoundary: target not found: ${target}`);
    process.exit(2);
  }

  let anyBlocked = false;

  if (fromStdin) {
    const content = readFileSync(0, "utf-8");
    const ok = checkOne(target, content);
    anyBlocked = !ok;
  } else {
    const files = collectFiles(target);
    for (const f of files) {
      const content = readFileSync(f, "utf-8");
      if (!checkOne(f, content)) anyBlocked = true;
    }
    if (files.length > 1 && !anyBlocked) {
      console.log(`OK     ${files.length} files scanned, zero blocks.`);
    } else if (files.length === 1 && !anyBlocked) {
      console.log(`OK     ${target}`);
    }
  }

  process.exit(anyBlocked ? 1 : 0);
}

main();
