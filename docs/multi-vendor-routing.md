# Chats and jobs across vendors

Husk keeps each chat and job's vendor independent. The sidebar's **New chat** menu starts a separate discussion with an installed CLI. Preferences sets defaults for future chats; saving defaults does not restart an open chat or redirect a running job. Configuring an API endpoint does not intercept chats explicitly opened with a CLI.

In Native Chat, **Move discussion** offers another installed vendor. Choose **Continue with** the destination vendor to pass the transcript to it. This creates a new vendor session with a conversation handoff; it does not transfer hidden model state. The composer model picker changes the current chat's model. Context usage appears below the composer. Terminal appearance keeps its context details in the Context panel.

## Autopilot Models

Assign a vendor and model independently to:

- **Simple tasks** and **Complex tasks**, used for solo jobs and team workers.
- **Planner**, which splits team work.
- **Integrator**, which combines team results.

Choose a vendor to load its model catalog, or leave the vendor on **Automatic**. An Automatic model uses the selected CLI's default model. Model dropdowns load the same live lists and display names as chat, reusing an open chat's catalog when available. Codex can also list models without opening a discussion. Available catalogs come from the selected vendor; an unavailable catalog leaves Automatic usable. Existing explicit model pins are retained when migrating settings.

Automatic vendor selection considers installed CLIs in this stable order: Claude, Codex, Gemini, Copilot, Kiro, Aider. Simple tasks and planning use the first installed option; complex tasks and integration use the second when available. Automatic team workers are distributed across installed vendors unless a configured assignment or planner-selected vendor applies. This is a deterministic starting policy, not a quality or price ranking.

The run form's **Job vendor** and model override solo jobs and team workers. Planner and Integrator retain their own settings. Explicit workflow step vendors/models are preserved; unassigned steps use the task routing settings. Assignments are captured before queueing so changing defaults later does not change queued workers, workflow steps, or integration.

## Usage alerts

A context warning appears once per discussion when it reaches the configured threshold (75% by default). It offers **Change vendor**, **Continue with another model**, and **Dismiss**. Increasing usage, temporary lower readings, or reloading the renderer do not repeat the same warning. A new conversation or a real new usage window can warn again. The bell retains usage details and clears its unread count when opened.

Codex questions use the same selectable question card as Claude, including suggested choices and free text. Pending questions survive renderer reloads and disappear when the agent withdraws them. Permission auto-approval does not answer questions for you.
