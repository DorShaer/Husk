# PAI Configuration

PAI uses directly-edited configuration files. There is no template rendering or code generation step — files are what they are.

## Core Files

| File | Purpose | Git Status |
|------|---------|------------|
| `settings.json` | Claude Code runtime config — hooks, permissions, identity, env, notifications, tips | Tracked |
| `CLAUDE.md` | Operational instructions loaded at session start | Tracked |
| `PAI/PAI_SYSTEM_PROMPT.md` | Constitutional rules (system prompt layer) | Tracked |
| `PAI/USER/Config/PAI_CONFIG.yaml` | Credentials store for private skills (HOMEBRIDGE, etc.) | Gitignored |

## How It Works

**Edit directly.** When you need to change hooks, identity, permissions, or any runtime behavior, edit `settings.json` directly. When you need to change operational rules or context routing, edit `CLAUDE.md`. When you need to change constitutional rules, edit `PAI/PAI_SYSTEM_PROMPT.md`.

Changes to `settings.json` and `CLAUDE.md` take effect at the next session start. Changes to `PAI_SYSTEM_PROMPT.md` (loaded via `--append-system-prompt-file`) also take effect next session.

## Public Releases

The Shadow Release system (`skills/_PAI/TOOLS/ShadowRelease.ts`) handles sanitization for public releases via **containment**, not filter-based reverse-templating. Pipeline: rsync clone with hard cache exclusions → delete sensitive zones (USER, MEMORY, private underscore-prefixed skills) → overlay fixed public templates from `skills/_PAI/TEMPLATES/` → scaffold empty USER/MEMORY → run five security gates (zone deletion check, identity regex grep, Cloudflare ID grep, trufflehog scan, `.env` stray check) → write `.shadow-state.json` report.

See the _PAI skill workflows:

- **CreateShadowRelease** — fresh build at a version: `bun run ShadowRelease.ts --create <version>`
- **UpdateShadowRelease** (`/ur`) — rebuilds at the current version (alias for create; no incremental mode under containment): `bun run ShadowRelease.ts --update`
- **CheckReleaseSecurity** — read-only gate check on existing staging: `bun run ShadowRelease.ts --check [--version <v>]`

The old filter/allowlist system (`release-patterns.yaml`, `template-map.yaml`, `SecurityVerifier.ts`, `IncrementalRelease.ts`, `CheckReleaseSafety.ts`) was retired. Under containment, sensitive-data policy lives in the tool's exclusion list and zone deletion code, not in YAML configs.

## PAI_CONFIG.yaml

This file is a credentials store, not a template source. Private skills (like `_HOMEBRIDGE`) read it directly for API keys and service credentials. It is gitignored and never included in public releases.

## Identity

DA and principal identity values live directly in `settings.json` under `daidentity` and `principal` keys. Hooks read these via `hooks/lib/identity.ts`.
