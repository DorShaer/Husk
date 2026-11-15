# Chats, rules and usage

## Choose a CLI or folder

The New menu lists the installed CLIs, with the most recently used first. Each entry names the folder it will open in. Terminal starts a regular shell. With one detected CLI, the menu uses the shorter New chat label.

In a native chat, select the CLI chip or the folder chip in the composer to change context. Choose **Continue this discussion** to carry a transcript into the new session, or **Start fresh** for an empty thread. If a reply is running, confirm that it should stop first.

A continuation includes user messages, assistant replies, brief tool summaries and changed filenames. Raw tool output and private reasoning are not copied. Long histories are supplied through a private local file that the receiving CLI is asked to read. The first new prompt displays a continuation notice.

In the chat's Sessions column, Continue with another CLI is available from a saved session's context menu. The source conversation remains on disk. Context injected for a continuation is hidden from restored message bubbles and session titles.

Terminal-only CLIs receive continuation text through the terminal paste path. Review that text and submit it in the CLI. A terminal-only CLI does not gain a native history reader or a normalized transcript reader through this feature.

## Answer an agent's questions

Claude and Codex can display questions as selectable cards inside the thread. Pick an option, or type an answer when offered, then select Submit. Dismiss returns no answer. Questions still ask for your input when Allow all is enabled. A pending Codex question survives Ctrl+R while its agent process is running; the card closes if Codex withdraws the request. Non-blocking questions stay available while the agent continues working.

Codex uses the [app-server question protocol](https://developers.openai.com/codex/app-server#toolrequestuserinput), with answers returned by question id. Start a new Codex agent process after updating Husk to enable the client capability.

## Local transcript retention

Native chat events are recorded under the Husk config directory in `transcripts/`. The files contain conversation data and should be treated as private. Each file is bounded to 2 MiB; older content is replaced by a truncation notice as needed. Tool output is shortened and thoughts are not retained by this store.

**Preferences > Appearance > Transcript retention** controls startup pruning, with a default of 30 days. Zero disables age-based pruning. Private large-handoff files use the same retention period. This setting does not delete the underlying CLI's own history.

## Brain rules

Use Add rule, or select Make this a rule on a note. Rules are explicit user instructions, separate from recalled reference notes. They apply to all workspaces by default and can be limited to the current workspace.

Rules bypass text similarity matching. Pinned rules go first, followed by newer ones. The prompt budget allows up to 12 rules and about 800 characters; the Rules tab identifies overflow. Each rule is limited to 300 characters. Turn a rule off to keep it without sending it, or stop using it as a rule to restore normal note recall.

Chat prompts receive active rules on each ordinary turn. Slash commands retain their native behavior. New terminal sessions receive rules through the existing instruction channel; restart a terminal session after changing its rules. Delivering an instruction does not force a CLI to follow it.

Captured conversations and imported files cannot silently become rules.

## Usage bell and budgets

The bell lists available plan, context-window and local daily-budget readings. Missing readings mean unknown usage, not unlimited usage. Warnings default to 75 percent and critical warnings to 90 percent; both thresholds are configurable in Preferences > Usage.

The badge counts unread alerts. Opening the bell clears the badge while keeping the usage readings visible. Alert state is stored locally, so Ctrl+R and app restarts do not repeat the same toast or restore a viewed badge. A new source, a higher warning level or a new usage window can raise a new alert. A changed reset estimate is not a new window; the previous window must end first. Temporary healthy readings do not rearm an existing plan alert. Records expire after 30 days and storage keeps the latest 200 sources.

Direct plan readings retain their existing default and can be disabled. With the direct source off, Husk relies on CLI-reported plan events. Other CLIs can still report context or reach their own limits without providing a plan percentage.

Daily budgets count usage observed in Husk's native chats. They exclude other applications and unreported usage. Cached input is included when reported. Resumed session counters establish a fresh observed baseline. Dollar figures are approximate CLI estimates, not bills; subscription list prices are excluded. Running cost totals are converted to deltas rather than added repeatedly. See the [upstream cost semantics](https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode).

Optional budget confirmation holds a message before sending. Cancel keeps a typed draft or restores an automatically dequeued message to the queue. Budgets reset at local midnight. A budget is a local reminder, not an account-wide provider limit or an authoritative spending control.

When a CLI reports a reached limit, the affected chat offers continuation with another installed CLI. An error-text match is labeled as a possible limit because it is inferred.
