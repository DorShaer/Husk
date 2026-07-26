# Skills and prompts

Husk keeps two different things on two different pages, because they behave differently.

| | Skills | Prompts |
|---|---|---|
| Live in | `~/.claude/skills/` | `~/.config/husk/prompts/` |
| Loaded by | the agent, on its own | nothing; you send them |
| Page | **Skills** | **Prompts** |

## Skills: `~/.claude/skills/`

A skill is a folder holding a `SKILL.md`, plus any files it needs. The agent reads the front-matter `name` and `description` at startup and decides for itself when a skill is relevant, then reads the body at the moment it invokes it.

That is the whole contract, and it is why the Skills page has no "run this" button. An enabled skill is already available; pasting its body into the chat would spend the context the skill exists to save and take the decision away from the model.

Husk's job is to manage what the agent can see:

- **List** every skill folder, including disabled ones (prefixed `_disabled_`).
- **Enable or disable**, one at a time or a whole source at once. Toggling renames the directory between `<name>` and `_disabled_<name>`, so the agent picks it up or skips it on its next launch.
- **Import** a skill you already have.
- **Show** each description, so the library is scannable.

Changes reach the agent when a session starts, so the confirmation carries a **Restart agent** button.

## The Skills page

Two panes. Sources on the left, their skills on the right.

```
SOURCES                shiv                                 All on  ●
  All skills    82     23 of 23 enabled
  Recently added 2     ─────────────────────────────────────────────
  Library       54     hunt-xss     Hunting skill for xss…        ●
▏ shiv          23     hunt-sqli    Hunting skill for sqli…       ●
SHOW                   hunt-ssrf    Hunting skill for ssrf…       ●
  All
  Enabled
  Disabled
```

- **Sources** come from the folder prefix a name already carries. A prefix earns its own entry once at least three skills share it, so `shiv-hunt-xss` and its siblings group under `shiv`; everything else stays under `Library`. The row then drops the prefix its source already states, showing `hunt-xss`, while search still matches the full name.
- **Recently added** lists what was installed in the last 14 days, newest first. It appears only when something qualifies. Install time comes from the skill directory's own mtime, so enabling or disabling a skill does not make it look new.
- **Show** filters by state, and composes with the selected source rather than replacing it.
- **The header switch** enables or disables everything currently in view. It sits mid-track when a source is only partly on.
- **The row switch** is the only per-skill control.

Clicking a row opens its detail panel with the full `SKILL.md`.

### Adding a skill

- **Create skill** writes a new one from a name, description and body.
- **Import** picks one or more `.md` files and installs each as `~/.claude/skills/<name>/SKILL.md`.
- **Drag a `.md` onto the window** and choose **Install as skill**, which lands in the same place. The other target, **Add to context**, copies into `~/.claude/MEMORY/CONTEXT/` and puts the quoted path in the agent's pending input instead.

## Prompts: `~/.config/husk/prompts/`

Prompts are template strings Husk owns. Nothing auto-loads them. Each has a **Send** action that types the prompt into the active chat, exactly as if you had typed it. That is how a CLI without a skill loader still gets something useful.

Toggling a prompt hides it from the list by renaming `<name>.md` to `<name>.md.disabled`. Your edits are never overwritten by a Husk upgrade.

### Default prompts shipped with Husk

On first launch Husk seeds `~/.config/husk/prompts/` from `installer/prompts/`. The seed never overwrites a file you already have, so editing a default and then upgrading is safe.

| File | What it does |
|------|--------------|
| `explain-this-code.md` | Asks for a file or paste, then explains the code in plain language with a flow trace, dependencies, risks, and a "if you change one thing, change this" pointer. |
| `plan-a-feature.md` | 8-question PM-intake protocol. Walks you through naming the user, problem, success metric, MVP scope, anti-scope. Emits a baked spec at the end. |
| `write-pr-description.md` | Generates a clean PR description from a diff or branch range. Conventional-commits title, "why not what" summary, test plan, risk notes. |
| `audit-for-security.md` | Methodical security review. Trust boundaries, input handling at each, AuthN/AuthZ, crypto sanity, OWASP-class issues with severity tags. |
| `summarize-this-document.md` | Three-layer summary: TL;DR, key points (5 to 8 bullets), section-by-section. No filler. |
| `debug-this-error.md` | Guided triage. Quote the error literally, translate, narrow cause, ask one question if needed, propose surgical fix, verify. |

## Why two pages

A skill and a prompt answer different questions. "What is my agent allowed to reach for?" is a library you curate and then leave alone. "What do I want to say right now?" is something you fire. Putting both in one list made a single row mean two different things: some rows were invoked by the model, others only by you, and the page had to explain the difference in a badge on every line. Splitting them lets each page state one rule.
