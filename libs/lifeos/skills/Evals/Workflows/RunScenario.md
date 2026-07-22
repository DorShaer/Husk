# RunScenario

Run a multi-turn agent scenario — simulated user drives N-turn conversation against a LifeOS agent, JudgeAgent evaluates criteria, results flow through Evals' pass@k pipeline.

## When to use

- Testing whether a multi-turn assistant handles a realistic user flow end-to-end.
- Regression-testing that an agent stays on criteria across turns.
- Evaluating assistants that need user interaction (refund flows, onboarding, dialogs).
- Verifying prompts hold up under simulated adversarial or edge-case users.

**NOT for:** single-shot output grading → use `RunEval` with an existing use case.

## Prerequisites

- `ANTHROPIC_API_KEY` in environment (required — scenario's UserSimulatorAgent and JudgeAgent call the Anthropic API directly).
- A scenario file at `Scenarios/<name>.scenario.ts` exporting a `ScenarioConfig`. If one does not yet exist, run the **CreateScenario** workflow first.

## Steps

1. **Confirm the scenario file path.** If none exists, route to `CreateScenario`.

2. **Run the scenario** (single trial first, for fast iteration):
   ```bash
   cd ${LIFEOS_SKILL_DIR}
   bun run Tools/ScenarioRunner.ts --scenario Scenarios/<name>.scenario.ts
   ```

3. **Inspect the output** in `LIFEOS/MEMORY/STATE/Evals-Results/<scenario-id>/<run-id>/`:
   - `run.json` — the full `EvalRun` with pass rates, pass@k, pass^k
   - `transcripts/trial_N.json` — per-trial `Trial` with `Transcript` + judge `GraderResult`

4. **If iterating on a prompt or config**, rerun with more trials for reliability:
   ```bash
   bun run Tools/ScenarioRunner.ts --scenario Scenarios/<name>.scenario.ts --trials 3
   ```
   pass@3 measures capability (did it succeed at least once); pass^3 measures consistency (did all 3 succeed).

5. **Emit summary to the user:** pass_rate, pass@k, unmet criteria (from the last failing trial's `GraderResult.details.unmet_criteria`), and the `run.json` path.

## Exit codes

- `0` — pass@k = 1 (at least one trial passed the judge)
- `1` — all trials failed the judge
- `2` — usage error (no `--scenario` flag)
- `3` — missing `ANTHROPIC_API_KEY`
- `4` — scenario file not found
- `5` — scenario module invalid (missing `name`/`description`/`agents`)
- `10` — fatal runtime error

## Options

| Flag | Default | Purpose |
|------|---------|---------|
| `--scenario <path>` | required | Path to `.scenario.ts` file |
| `--trials <n>` | 1 | Number of trials for pass@k statistics |
| `--suite <name>` | none | Tag the run as part of a named Evals suite |
| `--json` | false | Also emit full `EvalRun` JSON to stdout |

## Notes

- Single-trial runs are useful for debugging a scenario. For regression suites, default to 3+ trials.
- `ScenarioRunner` reuses Evals' `Transcript`/`Trial`/`EvalRun` types directly — scenario runs show up alongside traditional eval runs in `ViewResults`.
- The judge's verdict is mapped to a synthetic `llm_rubric` `GraderResult` (score = met_criteria / total_criteria), so scenario results compose with other graders in the future if needed.
