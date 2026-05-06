# Skills and prompts

Husk's Skills page is a unified surface for two different stores. Each row carries a small badge so you always know which kind of thing you are looking at.

## The two stores

### Claude skills — `~/.claude/skills/`

These are the skills the **agent** auto-loads when it starts. Each skill is a folder containing a `SKILL.md` (plus optionally extra files). Claude reads the front-matter `name` + `description` from `SKILL.md` and decides on its own when to invoke that skill, based on the description.

Husk does not load these into the chat. Claude does. Husk's job here is to:

- **List** every skill folder under `~/.claude/skills/`, including disabled ones (those prefixed with `_disabled_`).
- **Toggle** them on or off. Toggling renames the directory between `<name>` and `_disabled_<name>` so claude either picks it up or skips it on the next launch.
- **Show** their description so you can scan the library at a glance.

Source badge: `skill`.

### Husk-managed prompts — `~/.config/husk/prompts/`

These are **template strings** Husk owns. They never auto-load into the agent. Instead each one has a "Use ▶" button. Click it and Husk types the prompt into the active chat. The agent receives it as if you had typed it yourself.

This is how Husk gives non-claude CLIs (copilot, codex, aider, gemini) something useful to do on the Skills page even though those agents don't have a skill loader.

Toggling here is a "hide from list" flag (rename `<name>.md` to `<name>.md.disabled`). User edits to a prompt's text never get overwritten by Husk upgrades.

Source badge: `husk`.

## Default prompts shipped with Husk

On first launch Husk seeds `~/.config/husk/prompts/` from `installer/prompts/`. The seed never overwrites a file the user already has, so editing a default prompt and then upgrading Husk is safe.

| File | What it does |
|------|--------------|
| `explain-this-code.md` | Asks for a file or paste, then explains the code in plain language with a flow trace, dependencies, risks, and a "if you change one thing, change this" pointer. |
| `plan-a-feature.md` | 8-question PM-intake protocol. Walks the user through naming the user, problem, success metric, MVP scope, anti-scope. Emits a baked spec at the end. |
| `write-pr-description.md` | Generates a clean PR description from a diff or branch range. Conventional-commits title, "why not what" summary, test plan, risk notes. |
| `audit-for-security.md` | Methodical security review. Trust boundaries, input handling at each, AuthN/AuthZ, crypto sanity, OWASP-class issues with severity tags. |
| `summarize-this-document.md` | Three-layer summary: TL;DR, key points (5–8 bullets), section-by-section. No filler. |
| `debug-this-error.md` | Guided triage. Quote the error literally, translate, narrow cause, ask one question if needed, propose surgical fix, verify. |

## The Skills page UI

```
[ Filter skills...  ]  ↻  Open folder  + Create skill

Agents       SKILL  Use ▶  ●        compose CUSTOM agents...
audit        SKILL  Use ▶  ●        deep source-code audit...
poc          SKILL  Use ▶  ●        proof-of-concept exploit...
explain-this-code  HUSK  Use ▶  ●  plain-language code explanation...
...
```

- **Use ▶** on any row pastes the prompt into the active chat. Works for both stores.
- **Toggle** flips the on/off state in place (animated iOS-style switch, same shared component as everywhere else in the product).
- **Source badge** (`SKILL` or `HUSK`) tells you which store the row belongs to.
- **Filter** does fuzzy match across name + description.

## Page label per agent

The page is always called "Skills" regardless of which CLI you picked. The cross-CLI handling is internal: claude auto-loads `~/.claude/skills/`, generic agents only see `Use ▶`. The subtitle adapts:

- claude: `auto-loaded by claude · click Use to inject manually`
- generic: `click Use to inject any skill into the chat`

## Adding a new prompt

The fast path: click `+ Create skill` in the Skills page header. The modal asks for name (lowercase letters/digits/dashes, must start with a letter), description, and content. Husk picks the right store based on the active agent (claude → `~/.claude/skills/<name>/SKILL.md`, otherwise → `~/.config/husk/prompts/<name>.md`).

The slow path: drop a `.md` file onto the Husk window. The drag overlay offers two targets:
- **Add to context** → copy into `~/.claude/MEMORY/CONTEXT/` and inject `Please read the file I just shared: <path>` into the active chat
- **Install as skill** → copy into `~/.claude/skills/<basename>/SKILL.md`

## Why one page

Showing two stores side-by-side keeps the user's mental model simple: "things I can use with my agent". The internal split — auto-loaded vs. paste-on-click — is a badge, not a separate page. New users do not need to learn the difference to be productive.
