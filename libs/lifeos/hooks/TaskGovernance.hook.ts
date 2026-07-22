#!/usr/bin/env bun
/**
 * @version 1.2.2
 * TaskGovernance.hook.ts - Subagent Task Creation Governance (TaskCreated)
 *
 * PURPOSE:
 * Gates task creation by subagents. Prevents runaway task spawning and
 * blocks empty-description tasks.
 *
 * TRIGGER: TaskCreated
 *
 * OUTPUT:
 * - exit(0): Allow task creation
 * - exit(2): Block task creation (stderr fed back to model)
 *
 * GOVERNANCE RULES:
 * 1. Block tasks with empty descriptions (quality gate)
 * 2. Rate limit: max 50 tasks per session to prevent runaway spawning
 */

import { readFileSync } from "fs";
import { join } from "path";

const input = JSON.parse(readFileSync("/dev/stdin", "utf-8"));

const { task_description } = input;

// --- Quality gate: block empty descriptions ---
if (!task_description || task_description.trim().length < 10) {
  process.stderr.write(
    `Task creation blocked: description too short (${task_description?.length ?? 0} chars). Provide a meaningful task description of at least 10 characters.`
  );
  process.exit(2);
}

// --- Rate limit: track tasks per session via temp file ---
// CLAUDE_SESSION_ID doesn't exist in env, so we use ppid (Claude Code process)
// and reset the counter when the session (ppid) changes.
const trackFile = join("/tmp", "pai-task-governance.json");
let taskCount = 0;
const currentPpid = String(process.ppid);

try {
  const data = JSON.parse(readFileSync(trackFile, "utf-8"));
  if (data.ppid === currentPpid) {
    taskCount = data.count || 0;
  }
  // Different ppid = new session, counter resets to 0
} catch {
  // File doesn't exist or is corrupt — first task this session
}

const MAX_TASKS_PER_SESSION = 50;
if (taskCount >= MAX_TASKS_PER_SESSION) {
  process.stderr.write(
    `Task creation blocked: session limit of ${MAX_TASKS_PER_SESSION} tasks reached. This prevents runaway task spawning. Complete existing tasks before creating new ones.`
  );
  process.exit(2);
}

// Increment counter with session tracking
const { writeFileSync } = await import("fs");
writeFileSync(trackFile, JSON.stringify({ ppid: currentPpid, count: taskCount + 1 }));

// Allow task creation
process.exit(0);
