# Setup — system integration (phase 1)

Wires LifeOS into the user's machine. Runs FIRST, always — hooks and integration must land before the Interview seeds anything. One continuous UX; this is the "logistics" half, the Interview is the "meaning" half.

## Voice notification (first action)

```bash
curl -s -X POST http://localhost:31337/notify -H "Content-Type: application/json" \
  -d '{"message": "Running the Setup workflow in the LifeOS skill to integrate LifeOS into your system"}' > /dev/null 2>&1 &
```

## Two-tier model

Deployment is **two tiers**, and the install presents them that way:

- **LifeOS Core** (steps 4–6, 8, 8.5) — system prompt + base settings + `CLAUDE.md`/identity, the skills library and the LIFEOS runtime (Algorithm, documentation, tools, statusline, version, user-templates) deployed by `DeployCore` (step 4.5), **and the `lifeos` launch command that actually loads the system prompt** (step 8.5). This IS LifeOS; it installs as one bundle after a single consent ("install LifeOS Core?"). Declining means not installing LifeOS at all.
- **Enhancements** (step 7) — hooks, statusline, tool tips, spinner verbs, agents, Pulse, launchd jobs. À la carte: the user (or their AI, from context) picks some, all, or none. Each is independently deployable, idempotent, and reversible.

The skill ships everything for both tiers in its payload; nothing activates without the matching consent.

## Steps

1. **DetectEnv** — `bun Tools/DetectEnv.ts` → `{os, harness, display, ssh, bun, existingInstall, isDevTree, settingsExists, claudeMdExists}`. Thin entry point over the sibling `Tools/InstallEngine.ts` (`detectEnv()`) — a reshaped, bare-skill subset of the legacy installer engine.
   - **If `isDevTree` → STOP.** Never mutate the author's source repo. Print the refusal and exit.
2. **ScanConflicts** (read-only) — `bun Tools/ScanConflicts.ts` → existing settings hooks, skill-name collisions, existing populated config tree. Produces the branch decision for `LinkUser`.
3. **Prereqs** — confirm `bun` present; confirm harness is one of the supported set; surface any missing prerequisite as a plain-language fix, do not auto-install system packages.
   - **If `harness.confidence` is `"assumed"`, confirm the harness with the user before branching** — detection was a guess (config dir without the harness binary, or the clean-machine default), and a leftover `~/.claude` dir must not send a non-Claude-Code install down the Claude Code path (hooks + `lifeos` alias both require the `claude` CLI). Ask which harness is actually running this setup, and branch on the answer.
### — LifeOS Core (steps 4–6, 8; one consent) —

4. **System overlay** — place the harness-root system files (each `existsSync`-guarded — never clobber a populated harness):
   - `install/CLAUDE.template.md` → `CLAUDE.md` (the routing table; its identity `@`-imports ship dormant as `# @LIFEOS/USER/...` and are activated later by `ActivateImports`).
   - `install/LIFEOS/LIFEOS_SYSTEM_PROMPT.md` → the system prompt. This is the real, public-clean system prompt shipped in the payload — used directly, no separate template.
   - **settings → `bun Tools/InstallSettings.ts`** (dry-run first, then `--apply`): places `install/settings.system.json` → `settings.json` (the system half — WITHOUT hooks; `InstallHooks` owns hooks). The tool expands `$HOME`/`~` in `env` values at write time — the harness injects env values verbatim (#1404/#1451), so a hand copy ships literal `$HOME/...` strings that create a real `$HOME/` junk directory at runtime. Never copy this file by hand.
   - Substitute `{{LIFEOS_VERSION}}` / `{{DA_NAME}}` / `{{PRINCIPAL_NAME}}` placeholders in the placed files (the engine's `substituteTree`).
4.5. **Deploy core system: skills + runtime** — `bun Tools/DeployCore.ts` (dry-run first, then `--apply`): copyMissing's the shipped `install/skills/` → `<configRoot>/skills/` (the ~50-skill library) and `install/LIFEOS/` → `<configRoot>/LIFEOS/` (the runtime — ALGORITHM, DOCUMENTATION, TOOLS, PULSE, statusline, VERSION, USER_TEMPLATES), EXCLUDING `USER` (step 5 scaffolds it) and `LIFEOS_INSTALL`; the empty `MEMORY/` tree (WORK/KNOWLEDGE/LEARNING/STATE/OBSERVABILITY/SKILLS) is scaffolded here too so the runtime has a home to write to. Targets ALL-CAPS `LIFEOS` so the `@LIFEOS/...` imports resolve. Never overwrites a populated file (idempotent), refuses the dev tree (`isDevTree` → exit 2), and FAILS LOUD (exit 1) if a required payload source is absent — never a silent no-op. **Runs BEFORE ScaffoldUser**: the active `@LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md` import must resolve and the skills must exist before the rest of setup.
5. **ScaffoldUser** — `bun Tools/ScaffoldUser.ts` → `existsSync`-guarded copyMissing from the shipped `templates/USER/` into the user config tree. Never overwrites a populated file.
6. **LinkUser** — `bun Tools/LinkUser.ts` → relocate/symlink the config tree into the harness tree (3-branch logic ported from the install engine; EXDEV fallback; throw on symlink failure). Config root keeps its canonical name.
### — Enhancements (step 7; à la carte, some/all/none) —

7. **Enhancements menu** — present the seven optional components; let the user (or their AI, from context) pick any subset. Two deployers back this, both `isDevTree`-refusing, idempotent, backup-before-write:

   | Component | What it deploys | Default |
   |-----------|-----------------|---------|
   | `hooks` | mode routing, memory, voice — most features need these | **recommended** |
   | `statusline` | `LIFEOS_StatusLine.sh` + `settings.json` `statusLine` | optional |
   | `tooltips` | `settings.json` `spinnerTipsOverride` — 265 LifeOS Claude-Code tips, shipped public-clean in `install/settings.enhancements.json` | optional |
   | `spinnerverbs` | `settings.json` `spinnerVerbs` — 523 custom spinner verbs, shipped in `install/settings.enhancements.json` | optional |
   | `agents` | the shipped `agents/` tree (copyMissing, never overwrites) | optional |
   | `pulse` | the Pulse dashboard as a `launchd` service (`:31337`) | optional |
   | `worksweep` / `derivedsync` | background `launchd` jobs | optional |

   - **hooks → `bun Tools/InstallHooks.ts`** (trust-gated): reads `install/hooks/hooks.json`, shows the EXACT change (file + settings-entry + event count), waits for explicit permission, backs up `settings.json`, merges additively per matcher bucket (idempotent via normalized-command dedup, preserves `type:"http"` verbatim).
   - **everything else → `bun Tools/DeployComponents.ts`**: dry-run first (no `--apply`, `--all` shows the full plan), then `--apply --components <csv>` with ONLY what the user picked. Reads enhancement settings from `install/settings.enhancements.json` (the keys split out of `settings.system.json` so they're genuinely opt-in, not force-bundled). A component whose prerequisite is absent reports a LOUD blocker and fails — never a silent no-op. macOS-only for `launchd`; skip silently on Linux/headless (`DetectEnv.display` false).
   - **Verify (two evidence classes)** per applied component: Pulse → `curl 127.0.0.1:31337/healthz` = 200; statusline/tooltips/spinnerverbs → re-read `settings.json` shows the key set; agents → files present under `agents/`; launchd jobs → `launchctl print` shows the label loaded.
8. **ActivateImports** — `bun Tools/ActivateImports.ts` → uncomment the identity `@`-imports in `CLAUDE.md`, each guarded by `existsSync` of the symlink-resolved target. Path literals stay as the canonical `@`-import form.
8.5. **Wire the launch command (Core)** — the constitutional system prompt placed in step 4 (`LIFEOS_SYSTEM_PROMPT.md`) only loads when the harness is launched with it appended; a plain `claude` session never sees it. Wire a `lifeos` launch command per `INSTALL.md` step 7 — **Claude Code:** a permission-gated `lifeos` alias in the user's shell rc (`alias lifeos='bun <configRoot>/LIFEOS/TOOLS/lifeos.ts -s <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md'`), shown exactly, rc backed up first, idempotent (never double-add); **other harnesses:** their own system-prompt flag against the same file. If the user declines the shell edit, hand them the one-line launch command to run by hand. **Without this, LifeOS Core is installed but launches un-constituted** (plain `claude`, no mode banner / verification / security layer).
9. **Verify (three evidence classes)** — (a) the config tree resolves (the identity `@`-imports load) — ALWAYS checked, it's Core; (b) IF the user opted into `hooks`, a probe session shows the mode banner / context injection fire. If hooks were declined, skip (b) and surface the caveat plainly: the constitutional mode banner and the memory/voice loop are hook-enforced, so without hooks LifeOS Core installs but runs un-bannered and un-augmented — recommend hooks unless there's a reason to decline; (c) the **launch command is wired** — grep the shell rc for the `lifeos` alias (or confirm the user was handed the manual one-line launch). Without it, Core installed but launches un-constituted — say so plainly. Report what was checked; never claim a hooks-fire pass when hooks weren't installed.
10. **Transition** — print: "Setup complete. Now let's get you into LifeOS —" and roll into `Workflows/Interview.md`.

## Notes
- Cross-platform: branch on `DetectEnv.os` for hook command shapes and path separators.
- Cross-harness: branch on `DetectEnv.harness` for the skills-dir location and hook command shapes; every harness gets the same imperative, permissioned hook install.
