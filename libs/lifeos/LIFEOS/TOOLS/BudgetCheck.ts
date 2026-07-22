#!/usr/bin/env bun
/**
 * BudgetCheck — backpressure against always-on context re-accretion.
 *
 * The doctrine-prune (2026-07-07) removed duplication and dead weight from the
 * files that load every turn. Without a ceiling those files regrow: memory
 * proposals auto-append, ISAs accrete, rules stack. This check reads
 * context-budgets.json and fails (exit 1) when any always-on file exceeds its
 * byte budget — so growth past the ceiling is a deliberate, git-recorded
 * decision (raise the budget) instead of silent drift.
 *
 * Wiring: the sanctioned push path (UpdateKaiRepo) should call this and refuse
 * to push over budget — that boundary is NOT bypassed by the --no-verify
 * checkpoint commits. A Stop-hook surfacing is the soft nag; this CLI is the
 * hard gate.
 *
 * Usage:
 *   bun BudgetCheck.ts            # table; exit 1 if any file over budget
 *   bun BudgetCheck.ts --json     # machine-readable
 *   bun BudgetCheck.ts --quiet    # only print on failure (for hooks)
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const CLAUDE_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const CONFIG = join(CLAUDE_DIR, "LIFEOS/TOOLS/context-budgets.json");

type Budget = { path: string; maxBytes: number; note?: string };
type Row = Budget & { bytes: number; over: boolean; pct: number; missing?: boolean };

function load(): { budgets: Budget[]; totalMaxBytes: number | null } {
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  return { budgets: cfg.budgets, totalMaxBytes: cfg.totalMaxBytes ?? null };
}

function measure(budgets: Budget[]): Row[] {
  return budgets.map((b) => {
    let bytes = 0;
    let missing = false;
    try {
      bytes = statSync(join(CLAUDE_DIR, b.path)).size;
    } catch {
      missing = true;
    }
    return { ...b, bytes, missing, over: !missing && bytes > b.maxBytes, pct: b.maxBytes ? bytes / b.maxBytes : 0 };
  });
}

function main() {
  const args = new Set(process.argv.slice(2));
  const { budgets, totalMaxBytes } = load();
  const rows = measure(budgets);
  const over = rows.filter((r) => r.over);
  const totalBytes = rows.reduce((s, r) => s + r.bytes, 0);
  const totalBudget = rows.reduce((s, r) => s + r.maxBytes, 0);
  // Total cap: per-file caps sum to ~184K and never bound the whole stack (2026-07-11, R3).
  const totalOver = totalMaxBytes !== null && totalBytes > totalMaxBytes;
  const failCount = () => over.length + (totalOver ? 1 : 0);

  // --cache: write a tiny summary the statusline reads cheaply (no bun spawn per render).
  if (args.has("--cache")) {
    const worst = rows.filter((r) => !r.missing).sort((a, b) => b.pct - a.pct)[0];
    const summary = {
      ts: new Date().toISOString(),
      totalPct: Math.round((totalBytes / totalBudget) * 100),
      totalBytes,
      totalMaxBytes,
      totalOver,
      overCount: over.length,
      worstPct: worst ? Math.round(worst.pct * 100) : 0,
      worstFile: worst ? worst.path.split("/").pop() : null,
      worstBytes: worst ? worst.bytes : 0,
      worstMax: worst ? worst.maxBytes : 0,
      over: over.map((r) => ({ file: r.path.split("/").pop(), pct: Math.round(r.pct * 100) })),
    };
    const cachePath = join(CLAUDE_DIR, "LIFEOS/MEMORY/STATE/context-budget.json");
    try {
      writeFileSync(cachePath, JSON.stringify(summary), "utf8");
    } catch {}
    if (!args.has("--json") && !args.has("--quiet")) console.log(`cache written: ${cachePath}`);
    process.exit(failCount() ? 1 : 0);
  }

  if (args.has("--json")) {
    console.log(JSON.stringify({ ok: failCount() === 0, totalBytes, totalBudget, totalMaxBytes, totalOver, rows }, null, 2));
    process.exit(failCount() ? 1 : 0);
  }

  const quiet = args.has("--quiet");
  if (!quiet || over.length) {
    console.log("── Always-on context budget ──");
    for (const r of rows.sort((a, b) => b.pct - a.pct)) {
      if (r.missing) { console.log(`  ??  MISSING            ${r.path}`); continue; }
      const bar = r.over ? "❌" : r.pct > 0.9 ? "⚠️ " : "✅";
      console.log(`  ${bar} ${String(r.bytes).padStart(6)} / ${String(r.maxBytes).padStart(6)} B  ${(r.pct * 100).toFixed(0).padStart(3)}%  ${r.path}`);
    }
    console.log(`  ── total: ${totalBytes} / ${totalBudget} B (${((totalBytes / totalBudget) * 100).toFixed(0)}%)${totalMaxBytes !== null ? ` · hard cap ${totalMaxBytes} B ${totalOver ? "❌ OVER" : "✅"}` : ""} ──`);
    if (over.length) {
      console.log(`\n❌ ${over.length} file(s) OVER budget. Prune before adding, or raise the budget in context-budgets.json (a deliberate, git-recorded decision).`);
      for (const r of over) console.log(`   • ${r.path}: ${r.bytes - r.maxBytes} B over`);
    }
    if (totalOver) {
      console.log(`\n❌ TOTAL over hard cap: ${totalBytes} > ${totalMaxBytes} B (${totalBytes - (totalMaxBytes as number)} B over). The always-on stack itself is too big — prune, don't shuffle.`);
    }
  }
  process.exit(failCount() ? 1 : 0);
}

main();
