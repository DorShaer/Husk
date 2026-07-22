#!/usr/bin/env bun
/**
 * ScenarioRunner — CLI entrypoint for multi-turn agent scenarios.
 *
 * Usage:
 *   bun Tools/ScenarioRunner.ts --scenario Scenarios/<name>.scenario.ts
 *   bun Tools/ScenarioRunner.ts --scenario <path> --trials 3
 *   bun Tools/ScenarioRunner.ts --scenario <path> --json
 *
 * Loads a scenario module (default export or named `scenario`), runs
 * scenario.run() for N trials, converts results through ScenarioToTranscript,
 * and writes an EvalRun JSON to LIFEOS/MEMORY/STATE/Evals-Results/<scenario-id>/<run-id>/.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, basename, dirname, join } from 'path';
import scenario, { type ScenarioConfig, type ScenarioResult } from '@langwatch/scenario';
import { buildTrial } from './ScenarioToTranscript.ts';
import type { EvalRun, Trial } from '../Types/index.ts';

interface Args {
  scenario: string;
  trials: number;
  json: boolean;
  suite?: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { scenario: '', trials: 1, json: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--scenario' || a === '-s') out.scenario = args[++i];
    else if (a === '--trials' || a === '-t') out.trials = parseInt(args[++i], 10);
    else if (a === '--suite') out.suite = args[++i];
    else if (a === '--timeout-ms') out.timeoutMs = parseInt(args[++i], 10);
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  if (!out.scenario) {
    printHelp();
    process.exit(2);
  }
  return out;
}

function printHelp(): void {
  process.stderr.write(`\nScenarioRunner — run a multi-turn agent scenario.\n\nRequired:\n  --scenario <path>    Path to a .scenario.ts module\n\nOptional:\n  --trials <n>         Number of trials for pass@k (default 1)\n  --timeout-ms <ms>    Per-trial timeout (default 180000 = 3 min)\n  --suite <name>       Evals Suite to associate this run with\n  --json               Emit run JSON to stdout in addition to file\n  -h, --help           Show this help\n\n`);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function requireAnthropicKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('\nERROR: ANTHROPIC_API_KEY is not set. scenario\'s UserSimulatorAgent and JudgeAgent require it.\nExport it in your shell, or add it to your environment, before running a scenario.\n\n');
    process.exit(3);
  }
}

async function loadScenarioModule(path: string): Promise<{ config: ScenarioConfig; id: string }> {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    process.stderr.write(`\nERROR: scenario file not found: ${resolved}\n\n`);
    process.exit(4);
  }
  const mod = await import(resolved);
  const candidate = mod.default ?? mod.scenario ?? mod.config;
  if (!candidate || !candidate.name || !candidate.description || !Array.isArray(candidate.agents)) {
    process.stderr.write(`\nERROR: ${path} must export default (or named 'scenario'/'config') a ScenarioConfig { name, description, agents }.\n\n`);
    process.exit(5);
  }
  const id = candidate.id ?? basename(resolved).replace(/\.scenario\.ts$/, '').replace(/\.ts$/, '');
  return { config: candidate as ScenarioConfig, id };
}

function computePassRates(trials: Trial[]): { passRate: number; meanScore: number; stdDev: number; passAtK: number; passToK: number } {
  const n = trials.length;
  if (n === 0) return { passRate: 0, meanScore: 0, stdDev: 0, passAtK: 0, passToK: 0 };
  const passed = trials.filter((t) => t.passed).length;
  const scores = trials.map((t) => t.score);
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const passRate = passed / n;
  return {
    passRate,
    meanScore: mean,
    stdDev: Math.sqrt(variance),
    passAtK: passed >= 1 ? 1 : 0,
    passToK: passed === n ? 1 : 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const { config, id: scenarioId } = await loadScenarioModule(args.scenario);
  requireAnthropicKey();
  const runId = `${scenarioId}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const skillDir = resolve(dirname(new URL(import.meta.url).pathname), '..');
  // Run artifacts live outside the skill tree (runtime state, not skill content).
  // 'LIFEOS' exactly — 'LifeOS' only resolved on case-insensitive filesystems (#1461 class).
  const runDir = join(skillDir, '..', '..', 'LIFEOS', 'MEMORY', 'STATE', 'Evals-Results', scenarioId, runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, 'transcripts'), { recursive: true });

  process.stderr.write(`\nScenarioRunner\n  scenario: ${scenarioId}\n  run: ${runId}\n  trials: ${args.trials}\n  output: ${runDir}\n\n`);

  const trials: Trial[] = [];
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  for (let i = 1; i <= args.trials; i++) {
    const trialStart = Date.now();
    let result: ScenarioResult;
    let error: string | undefined;
    try {
      result = await withTimeout(scenario.run(config), args.timeoutMs, `scenario.run(${scenarioId}) trial ${i}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      result = {
        runId: `${scenarioId}_err_${i}`,
        success: false,
        messages: [],
        reasoning: `Scenario threw: ${error}`,
        metCriteria: [],
        unmetCriteria: [],
        totalTime: (Date.now() - trialStart) / 1000,
        error,
      } as ScenarioResult;
    }

    const trial = buildTrial({ taskId: scenarioId, trialNumber: i, result, error });
    trials.push(trial);
    writeFileSync(join(runDir, 'transcripts', `trial_${i}.json`), JSON.stringify(trial, null, 2));
    process.stderr.write(`  trial ${i}/${args.trials}: ${trial.passed ? 'PASS' : 'FAIL'} score=${trial.score.toFixed(2)}\n`);
  }

  const rates = computePassRates(trials);
  const completedAt = new Date().toISOString();

  const evalRun: EvalRun = {
    id: runId,
    task_id: scenarioId,
    trials,
    n_trials: trials.length,
    pass_rate: rates.passRate,
    mean_score: rates.meanScore,
    std_dev: rates.stdDev,
    pass_at_k: rates.passAtK,
    pass_to_k: rates.passToK,
    started_at: startedAt,
    completed_at: completedAt,
    total_duration_ms: Date.now() - startMs,
    metadata: {
      source: 'scenario',
      suite: args.suite,
      scenario_name: config.name,
    },
  };

  const runJsonPath = join(runDir, 'run.json');
  writeFileSync(runJsonPath, JSON.stringify(evalRun, null, 2));

  process.stderr.write(`\nSummary:\n  pass_rate: ${(rates.passRate * 100).toFixed(1)}%\n  mean_score: ${rates.meanScore.toFixed(2)}\n  pass@k: ${rates.passAtK}  pass^k: ${rates.passToK}\n  run.json: ${runJsonPath}\n\n`);

  if (args.json) process.stdout.write(JSON.stringify(evalRun, null, 2) + '\n');

  process.exit(rates.passAtK ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n\n`);
  process.exit(10);
});
