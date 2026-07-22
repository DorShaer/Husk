#!/usr/bin/env bun
/**
 * ScenarioToTranscript — converts a langwatch scenario.run() result into
 * Evals' native Transcript + Trial + GraderResult shapes so scenario runs
 * flow through the existing pass@k aggregator and Results pipeline.
 */

import type { ScenarioResult } from '@langwatch/scenario';
import type {
  Transcript,
  Turn,
  Trial,
  GraderResult,
  TranscriptMetrics,
  TaskStatus,
} from '../Types/index.ts';

export interface BuildTrialArgs {
  taskId: string;
  trialNumber: number;
  result: ScenarioResult;
  error?: string;
}

export function scenarioResultToTranscript(taskId: string, trialId: string, r: ScenarioResult): Transcript {
  const startedAt = new Date(Date.now() - Math.round((r.totalTime ?? 0) * 1000)).toISOString();
  const completedAt = new Date().toISOString();

  const turns: Turn[] = (r.messages ?? []).map((m, i) => ({
    index: i,
    role: normalizeRole(m.role),
    content: extractText(m.content),
    timestamp: completedAt,
  }));

  const metrics: TranscriptMetrics = {
    n_turns: turns.length,
    n_tool_calls: 0,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    wall_time_ms: Math.round((r.totalTime ?? 0) * 1000),
  };

  return {
    task_id: taskId,
    trial_id: trialId,
    started_at: startedAt,
    completed_at: completedAt,
    turns,
    tool_calls: [],
    final_outcome: { success: r.success, reasoning: r.reasoning },
    metrics,
  };
}

export function scenarioResultToGraderResult(r: ScenarioResult, wallTimeMs: number): GraderResult {
  const metCount = r.metCriteria?.length ?? 0;
  const totalCriteria = metCount + (r.unmetCriteria?.length ?? 0);
  const score = totalCriteria > 0 ? metCount / totalCriteria : r.success ? 1 : 0;

  return {
    grader_type: 'llm_rubric',
    weight: 1,
    score,
    passed: r.success,
    reasoning: r.reasoning ?? '',
    details: {
      source: 'scenario_judge',
      met_criteria: r.metCriteria ?? [],
      unmet_criteria: r.unmetCriteria ?? [],
      judge: 'scenario.JudgeAgent',
      run_id: r.runId,
    },
    duration_ms: wallTimeMs,
  };
}

export function buildTrial({ taskId, trialNumber, result, error }: BuildTrialArgs): Trial {
  const trialId = `${taskId}_t${trialNumber}`;
  const transcript = scenarioResultToTranscript(taskId, trialId, result);
  const wallTimeMs = transcript.metrics.wall_time_ms;
  const grader = scenarioResultToGraderResult(result, wallTimeMs);
  const status: TaskStatus = error ? 'error' : result.success ? 'passed' : 'failed';

  return {
    id: trialId,
    task_id: taskId,
    trial_number: trialNumber,
    status,
    started_at: transcript.started_at,
    completed_at: transcript.completed_at,
    transcript,
    grader_results: [grader],
    score: grader.score,
    passed: grader.passed,
    error: error ?? result.error,
  };
}

function normalizeRole(role: unknown): Turn['role'] {
  const r = String(role ?? 'assistant').toLowerCase();
  if (r === 'user' || r === 'assistant' || r === 'system' || r === 'tool') return r;
  return 'assistant';
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text);
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return JSON.stringify(content);
}
