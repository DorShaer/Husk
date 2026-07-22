#!/usr/bin/env bun
/**
 * @version 1.0.0
 * PreToolGuard.hook.ts — the ONE PreToolUse blocking-guard dispatcher.
 *
 * Consolidation (2026-07-11, security-hook unification): merges the three
 * PreToolUse BLOCKERS into one process, reading stdin ONCE:
 *
 *   Write | Edit | MultiEdit → SystemFileGuard.check   (deny-list → SYSTEM file)
 *   Bash                     → CommunicationSkillGuard.check (raw email send)
 *                              then EgressClassGuard.check     (over-ceiling Tier-2 egress)
 *
 * Each guard file keeps its logic and its own fail policy, and stays runnable
 * standalone via its own `import.meta.main` shim. This dispatcher is deliberately
 * dumb: it routes by tool, calls the isolated check(s), and the FIRST check
 * returning a block wins (stderr + exit 2). No block → exit 0.
 *
 * FAIL-POLICY PRESERVATION (the load-bearing invariant): each check owns its
 * fail behavior internally —
 *   - SystemFileGuard.check      fail-OPEN (returns null on internal error)
 *   - CommunicationSkillGuard.check  fail-OPEN
 *   - EgressClassGuard.check     fail-CLOSED when classification throws on a
 *                                Tier-2-signature call (returns a block),
 *                                fail-OPEN otherwise
 * The dispatcher wraps each call in its own try/catch so one guard throwing can
 * NEVER suppress the others; a guard that throws past its own handler is treated
 * as allow for that guard only (matches the pre-merge per-hook parse-fail path).
 *
 * BLAST RADIUS: this is one process where there used to be three. The mitigation
 * is per-check isolation above; the dispatcher body is ~30 lines and does no
 * parsing beyond one JSON.parse. Dispatcher-level parse failure → exit 0, which
 * is identical to the pre-merge world (every guard independently exited 0 on a
 * bad stdin). The fail-CLOSED path only arms AFTER a successful parse, inside
 * EgressClassGuard.check, so it is unaffected by dispatcher-level failure.
 *
 * ContextReduction.hook.sh stays a SEPARATE PreToolUse:Bash hook — it REWRITES
 * the command (updatedInput), a different contract from block/allow; mixing a
 * mutator into a blocking dispatcher is the wrong seam.
 *
 * EXIT CODES: 0 = allow, 2 = deny (message on stderr goes to the model).
 */

import { readFileSync } from "node:fs";
import { check as systemFileGuard } from "./SystemFileGuard.hook";
import { check as communicationSkillGuard } from "./CommunicationSkillGuard.hook";
import { check as egressClassGuard } from "./EgressClassGuard.hook";

type BlockResult = { block: true; message: string } | null;
type GuardCheck = (input: any) => BlockResult;

function isolate(name: string, fn: GuardCheck, input: any): BlockResult {
  try {
    return fn(input);
  } catch (err) {
    // A guard threw past its own handler. Treat as allow for THIS guard only —
    // never let one guard's crash suppress the others. (EgressClassGuard's
    // fail-CLOSED lives inside its own check, so a throw here means it never
    // confirmed a Tier-2 call.)
    console.error(`[PreToolGuard] ${name} threw:`, err);
    return null;
  }
}

function main(): never {
  let input: { tool_name?: string };
  try {
    input = JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    process.exit(0); // unparseable stdin → allow (matches pre-merge per-hook behavior)
  }

  const tool = typeof input.tool_name === "string" ? input.tool_name : "";

  // Route to the guard(s) for this tool, in the pre-merge order.
  const checks: Array<[string, GuardCheck]> =
    tool === "Write" || tool === "Edit" || tool === "MultiEdit"
      ? [["SystemFileGuard", systemFileGuard]]
      : tool === "Bash"
        ? [["CommunicationSkillGuard", communicationSkillGuard], ["EgressClassGuard", egressClassGuard]]
        : [];

  for (const [name, fn] of checks) {
    const result = isolate(name, fn, input);
    if (result?.block) {
      process.stderr.write(result.message);
      process.exit(2); // first block wins
    }
  }

  process.exit(0);
}

main();
