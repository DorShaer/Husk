# CreateScenario

Author a new multi-turn agent scenario file for the simulation-based testing pipeline (langwatch `scenario` framework wrapped into Evals).

## When to use

- A user wants to test whether a multi-turn agent handles a specific interaction flow.
- A failure was caught in production that needs a regression test covering the conversation pattern that triggered it.
- A capability eval is needed where the agent must sustain quality across 2+ turns.

**NOT for:** single-shot prompt comparisons → use `CreateUseCase`.

## Inputs needed from the user

Ask for and confirm:

1. **Scenario name** (kebab-case, e.g. `refund-dispute`)
2. **Description** (what happens — the user simulator reads this to drive the conversation)
3. **System prompt** for the agent under test (or "use the default")
4. **Success criteria** (1-5 plain-English bullet points the judge will evaluate)
5. **Max turns** (default 6)
6. **Inference level** for the agent under test: `low` | `medium` | `high` | `max` (default `medium`)

## Steps

1. **Scaffold the file** at `Scenarios/<name>.scenario.ts`:

   ```ts
   import { anthropic } from '@ai-sdk/anthropic';
   import scenario, { type ScenarioConfig } from '@langwatch/scenario';
   import { LifeosAgentAdapter } from '../Tools/LifeosAgentAdapter.ts';

   const judgeModel = anthropic('claude-sonnet-4-6');

   const config: ScenarioConfig = {
     name: '<scenario-name>',
     description: '<what happens in plain English>',
     agents: [
       new LifeosAgentAdapter({
         name: '<agent-name>',
         systemPrompt: '<system prompt for the agent under test>',
         level: 'medium',
       }),
       scenario.userSimulatorAgent({ model: judgeModel }),
       scenario.judgeAgent({
         model: judgeModel,
         criteria: [
           '<criterion 1>',
           '<criterion 2>',
         ],
       }),
     ],
     script: [scenario.user(), scenario.agent(), scenario.judge()],
     maxTurns: 6,
   };

   export default config;
   ```

2. **Save the file** under `Scenarios/<name>.scenario.ts` (kebab-case, `.scenario.ts` suffix required so `ScenarioRunner` identifiers derive cleanly).

3. **Smoke-test the scenario** with a single trial:
   ```bash
   bun run ${LIFEOS_SKILL_DIR}/Tools/ScenarioRunner.ts --scenario ${LIFEOS_SKILL_DIR}/Scenarios/<name>.scenario.ts
   ```

4. **Iterate on the criteria** until the judge's pass/fail decisions align with expert human judgment. Vague criteria cause judge flakiness; prefer specific, testable statements.

5. **When stable, hand off to `RunScenario`** for regression running (trials ≥ 3).

## Authoring guidance

- **Keep criteria narrow and testable.** "Assistant is helpful" is too vague. "Assistant offers to escalate to a human when user expresses frustration" is specific.
- **maxTurns is a ceiling, not a target.** Most scenarios should resolve in 2-4 turns.
- **Use `scenario.user("exact starting message")` for a deterministic first turn** if the conversation should always start the same way; use `scenario.user()` (no arg) to let the simulator generate organically from the description.
- **Match `level` to cost tolerance.** `low` (haiku-tier) is fine for most testing; `high` (opus-tier) or `max` (top rung) only when the agent under test genuinely needs deep reasoning.
- **Scripts can inject checkpoints:** `scenario.judge({ criteria: [...] })` mid-script fails the scenario early if criteria are unmet at that turn — useful for multi-stage flows.

## Structure

```
skills/Evals/
├── Scenarios/                       # authored scenarios live here
│   └── <name>.scenario.ts
├── Tools/
│   ├── LifeosAgentAdapter.ts           # wraps Inference.ts as scenario AgentAdapter
│   ├── ScenarioRunner.ts            # CLI entrypoint
│   └── ScenarioToTranscript.ts      # result → Evals types
```

## See also

- `Workflows/RunScenario.md` — execute the scenario once authored
- `Workflows/CreateUseCase.md` — single-turn alternative
- `Workflows/ViewResults.md` — inspect results alongside other evals
