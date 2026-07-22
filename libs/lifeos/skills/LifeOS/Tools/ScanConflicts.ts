#!/usr/bin/env bun
/**
 * ScanConflicts — Setup step 2. READ-ONLY conflict report. Surfaces everything
 * the Setup workflow must reconcile before any write: existing settings hooks,
 * a populated user config tree, LifeOS skill-name collisions, and discoverable
 * API keys (names only — never values). Produces no mutations.
 *
 * Thin entry point over InstallEngine; the branch decision for LinkUser/Install
 * is made by the workflow from this JSON.
 *
 * Usage: bun ScanConflicts.ts [--json]
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  detectEnv,
  detectExistingUserContent,
  scanApiKeys,
  scanSettingsHooks,
} from "./InstallEngine";

interface ConflictReport {
  configRoot: string;
  settingsHooks: ReturnType<typeof scanSettingsHooks>;
  existingUserContent: ReturnType<typeof detectExistingUserContent>;
  /** A LifeOS skill dir already present at the target (would be re-installed over). */
  lifeosSkillPresent: boolean;
  /** Provider names with a discoverable key in shell/config (VALUES never emitted). */
  apiKeyProviders: string[];
  /** True if any conflict needs a human decision before setup writes. */
  needsReconciliation: boolean;
}

function main(): void {
  const env = detectEnv();
  const configRoot = env.configRoot;
  const skillsDir = env.harness.skillsDir || join(configRoot, "skills");
  const userDir = join(configRoot, "LIFEOS", "USER");

  const settingsHooks = scanSettingsHooks(join(configRoot, "settings.json"));
  const existingUserContent = detectExistingUserContent(userDir);
  const lifeosSkillPresent = existsSync(join(skillsDir, "LifeOS"));

  // Names only — scanApiKeys returns values, but we surface ONLY the provider keys.
  const apiKeyProviders = Object.keys(scanApiKeys(env.homeDir, join(configRoot, "LIFEOS", "USER", "CONFIG")));

  const report: ConflictReport = {
    configRoot,
    settingsHooks,
    existingUserContent,
    lifeosSkillPresent,
    apiKeyProviders,
    needsReconciliation:
      settingsHooks.hookEntryCount > 0 || existingUserContent.populated || lifeosSkillPresent,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main();
