# Chats and jobs across vendors

Husk keeps each chat and job's vendor independent. The sidebar's **New chat** menu starts a separate discussion with an installed CLI. Preferences sets defaults for future chats; saving defaults does not restart an open chat or redirect a running job. Configuring an API endpoint does not intercept chats explicitly opened with a CLI.

In Native Chat, **Move discussion** offers another installed vendor. Choose **Continue with** the destination vendor to pass the transcript to it. This creates a new vendor session with a conversation handoff; it does not transfer hidden model state. The composer model picker changes the current chat's model. Context usage appears below the composer. Terminal appearance keeps its context details in the Context panel.

## Autopilot Models

Assign a vendor independently to:

- **Simple tasks** and **Complex tasks**, used for solo jobs and team workers.
- **Planner**, which splits team work.
- **Integrator**, which combines team results.

### Routed and Not routed

Each installed CLI is in one of two states, shown at the top of the Models panel:

- **Routed**: you picked a model for simple jobs and a model for complex jobs. Simple jobs run on the first, complex jobs, planning and integration on the second.
- **Not routed**: "This CLI uses its own default model for every task." No model controls are drawn for it; **Set up routing** opens the picker.

Claude ships Routed with `haiku` for simple jobs and `opus` for complex jobs. **Stop routing** returns any CLI to its own default model.

The picker reads a fresh model list from the CLI itself and offers only the ids it lists. When a CLI cannot list its models, **Enter a model id** accepts typed ids; a value that looks like status text, a file path or anything with spaces is refused.

A picked id is stored with the time the CLI listed it. When a job starts, Husk reads the CLI's list again (cached for five minutes). If the id is gone, the job runs on the CLI's default model and the run log says so in one line; a stale id never fails a run. Typed ids, and ids checked while the list cannot be read, are passed through unchanged.

A role row whose CLI is Routed also offers a model pin for that role alone. A pin always wins over the CLI's routing. Model dropdowns load the same live lists and display names as chat, reusing an open chat's catalog when available.

### What each job ran on

Every job records the vendor and model it ran on, or `<cli> (default)` when no model flag was passed. Artifacts shows it on each Autopilot run, one line per job for a team.

Automatic vendor selection considers installed CLIs in this stable order: Claude, Codex, Gemini, Copilot, Kiro, Aider. Simple tasks and planning use the first installed option; complex tasks and integration use the second when available. Automatic team workers are distributed across installed vendors unless a configured assignment or planner-selected vendor applies. This is a deterministic starting policy, not a quality or price ranking.

The run form's **Job vendor** and model override solo jobs and team workers. Planner and Integrator retain their own settings. Explicit workflow step vendors/models are preserved; unassigned steps use the task routing settings. Assignments are captured before queueing so changing defaults later does not change queued workers, workflow steps, or integration.

## Usage alerts

A context warning appears once per discussion when it reaches the configured threshold (75% by default). It offers **Change vendor**, **Continue with another model**, and **Dismiss**. Increasing usage, temporary lower readings, or reloading the renderer do not repeat the same warning. A new conversation or a real new usage window can warn again. The bell retains usage details and clears its unread count when opened.

Codex questions use the same selectable question card as Claude, including suggested choices and free text. Pending questions survive renderer reloads and disappear when the agent withdraws them. Permission auto-approval does not answer questions for you.

## Chat IDs and resume commands

Use **Chat actions** below a Native Chat message box, or right-click a chat tab or Sessions-column entry, to copy its chat ID or CLI resume command. The Sessions page detail menu has the same copy actions. Run copied commands from the chat’s project folder. IDs become available after the agent creates its session. A CLI or API connection that has no resume command reports that explicitly.

**Move discussion → Move to a specific chat ID** lets you choose the destination vendor and paste an ID. An open destination is focused; a saved local destination is resumed. Its existing history is preserved. The source transcript is included once with your next ordinary message, including after a renderer reload. Busy destinations and destinations already awaiting a handoff are left alone. The source chat remains available.

## Background image

Open **Preferences → Appearance**. The first card is **Background image**: choose a PNG, JPEG, or WebP image, then adjust Dim and Blur. Husk keeps a resized private copy, so the background survives moving the original file and restarting Husk. The preview shows your selection; Remove image restores the theme background. The image is visible behind Native Chat and page surfaces; cards and terminal text keep their reading backgrounds.
