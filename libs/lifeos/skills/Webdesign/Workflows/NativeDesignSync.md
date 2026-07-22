# NativeDesignSync

First-party Claude Design ↔ Claude Code sync via the native `/design` and `/design-sync` commands. This is **Path 2** — the preferred route for any code-bound design work. It replaces the hand-rolled Interceptor handoff-bundle apparatus (Path 3).

## Trigger Phrases

"/design", "/design-sync", "design sync", "sync design system", "pull design system into Claude Design", "push code back to Claude Design", "native design command"

## What These Commands Are

Anthropic shipped both commands inside Claude Code in the June 2026 Claude Design update. GA on Pro, Max, Team, and Enterprise at no extra cost. Official reference: `support.claude.com/en/articles/14604416-get-started-with-claude-design`.

| Command | What it does |
|---------|-------------|
| **`/design`** | Create, edit, and sync designs from inside the Claude Code terminal — no switch to the web app or desktop sidebar. |
| **`/design-sync`** | Bidirectional sync between the codebase and Claude Design. **Pull:** import the local codebase's real design system into Claude Design so generated designs use your actual components and tokens. **Push:** sync implemented code changes back into Claude Design so the canvas stays current. |

## Why This Path Wins for Code Work

The whole point of the old Path 3 bundle apparatus (`ExtractDesignSystem` → `CreatePrototype` → `ExportToCode` → `IntegrateIntoApp`) was to move a design system and a generated design between the browser canvas and the codebase. `/design-sync` does exactly that, natively and deterministically — no Interceptor automation, no authenticated browser profile, no ZIP parsing, no accessibility-tree heuristics that can drift. Prefer it.

## Workflow

### 1. Preflight

```bash
claude --version    # ensure a current build; if /design* is missing, run /update inside Claude Code
```

The commands appear only on a current Claude Code with a Claude Design–enabled subscription. If they don't show, run `/update`.

### 2. Pull the codebase design system into Claude Design

From inside the target repo, run `/design-sync` and choose the pull direction. This reads the real components and tokens from code (the native-first bet — no `.fig`, no Figma coupling) and primes Claude Design with them, so subsequent designs match what ships. This is the native equivalent of the old `ExtractDesignSystem` workflow.

### 3. Create or edit the design

Use `/design` to drive design work from the terminal, or open the design on the web canvas / desktop sidebar for visual review — the synced design system carries across surfaces.

### 4. Push built changes back

After implementing in code, run `/design-sync` in the push direction to update the Claude Design canvas, keeping design and code in lockstep.

### 5. Verify

Native sync does not exempt you from the skill's verification standard. For any web output, verify the rendered result through the **Interceptor** skill (real Chrome) before claiming done — a deploy/"is live" claim needs two evidence classes (DOM read + screenshot). See `Tools/VerifyDesign.ts` and the Interceptor `VerifyDeploy` workflow.

## When NOT to use this

- **Pure inline/ad-hoc design with no canvas round-trip** → use Path 1 (`DirectDesign`). Faster, no subscription dependency.
- **You specifically need the visual web canvas and accept the setup cost** → Path 3 (`CreatePrototype` et al.), after logging the `interceptor-test` profile into claude.ai.

## Gotchas

- **These are Claude Code CLI commands, not LifeOS skills or REST APIs.** There is still no public Claude Design REST API or MCP server — the CLI commands are the programmatic surface.
- **Subscription-gated.** Free tier has no Claude Design access; the commands won't function.
- **`/update` if missing.** The single most common "the command doesn't exist" cause is a stale Claude Code build.
- **Sync direction is explicit.** `/design-sync` is bidirectional — be deliberate about pull (code → Claude Design) vs push (Claude Design → code) so you don't overwrite the side you meant to keep.
