#!/usr/bin/env bun
/**
 * ISASync.hook.ts — Read-only ISA → work.json sync via PostToolUse
 *
 * TRIGGER: PostToolUse (Write, Edit)
 *
 * v4.1.0 (PRD → ISA rename): the per-session artifact is now ISA.md.
 * Sessions created before v4.1.0 still ship a PRD.md; this hook reads either,
 * preferring ISA.md when both exist (legacy behavior — there should never be
 * both for a single session).
 *
 * v3.2.0: Hooks are READ-ONLY from the artifact's perspective.
 * The AI writes all ISA content directly (criteria, checkboxes, frontmatter).
 * This hook ONLY reads the ISA and syncs to work.json for the dashboard.
 *
 * - Write/Edit on ISA.md (or legacy PRD.md) → read frontmatter + criteria → sync to work.json
 */

import { readFileSync, existsSync } from 'fs';
import {
  parseFrontmatter,
  syncToWorkJson,
  readRegistry,
  ARTIFACT_FILENAME,
  LEGACY_ARTIFACT_FILENAME,
} from './lib/isa-utils';
import { pushStateToTargets, pushEventsToTargets } from './lib/observability-transport';
import { setPhaseTab } from './lib/tab-setter';
import type { AlgorithmTabPhase } from './lib/tab-constants';

let input: any;
try {
  input = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  process.exit(0);
}

const toolInput = input.tool_input || {};

async function main() {
  // Only trigger for ISA.md (or legacy PRD.md) files in MEMORY/WORK/
  const filePath = toolInput.file_path || '';
  if (!filePath.includes('MEMORY/WORK/')) return;
  const isISA = filePath.endsWith('/' + ARTIFACT_FILENAME) || filePath.endsWith(ARTIFACT_FILENAME);
  const isLegacyPRD = filePath.endsWith('/' + LEGACY_ARTIFACT_FILENAME) || filePath.endsWith(LEGACY_ARTIFACT_FILENAME);
  if (!isISA && !isLegacyPRD) return;

  // Use the actual file path that was just written/edited, not findLatestISA()
  // findLatestISA() scans all artifacts by mtime and can return the wrong file
  // when multiple sessions exist or when a file's mtime is bumped by git ops.
  const isaPath = filePath;
  if (!existsSync(isaPath)) return;

  const content = readFileSync(isaPath, 'utf-8');
  const fm = parseFrontmatter(content);
  if (!fm) return;

  // Check existing phase before sync to detect phase changes
  const newPhase = (fm.phase || '').toUpperCase();
  let oldPhase = '';
  if (fm.slug) {
    try {
      const registry = readRegistry();
      const existing = registry.sessions[fm.slug];
      if (existing) oldPhase = (existing.phase || '').toUpperCase();
    } catch { /* silent */ }
  }

  // Sync frontmatter + criteria to work.json (pass session_id for session name lookup)
  syncToWorkJson(fm, isaPath, content, input.session_id);

  // Push to observability targets (awaited so process.exit doesn't kill the fetch)
  await Promise.all([pushStateToTargets(), pushEventsToTargets()]).catch(() => {});

  // Update tab color when algorithm phase changes
  const VALID_PHASES = new Set(['OBSERVE', 'THINK', 'PLAN', 'BUILD', 'EXECUTE', 'VERIFY', 'LEARN', 'COMPLETE']);
  if (newPhase !== oldPhase && VALID_PHASES.has(newPhase) && input.session_id) {
    try {
      setPhaseTab(newPhase as AlgorithmTabPhase, input.session_id);
    } catch (err) {
      console.error('[ISASync] setPhaseTab failed:', err);
    }
  }

}

main().catch(() => {}).finally(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
