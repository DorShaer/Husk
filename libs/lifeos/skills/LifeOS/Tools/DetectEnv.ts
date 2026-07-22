#!/usr/bin/env bun
/**
 * DetectEnv — Setup step 1. Read-only environment detection for the LifeOS
 * installer. Emits the JSON the Setup workflow branches on (OS, harness, GUI,
 * SSH, bun, existing install, dev-tree refusal flag, settings/CLAUDE.md state).
 *
 * Thin entry point over InstallEngine.detectEnv() — all logic lives there.
 *
 * Usage: bun DetectEnv.ts [--json]   (--json is the default and only format)
 */

import { detectEnv } from "./InstallEngine";

function main(): void {
  const env = detectEnv();
  // Single JSON object, jq-pipeable. The Setup workflow reads these fields by name.
  console.log(JSON.stringify(env, null, 2));
  // Exit 0 always — detection never "fails"; the workflow decides on the data.
  process.exit(0);
}

main();
