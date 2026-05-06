# Contributing

Quick reference for working on Husk. Skim once before sending your first PR.

## Dev setup

```bash
git clone https://github.com/DorShaer/Husk.git husk
cd husk
./run.sh
```

`run.sh`:
1. Runs `npm install` and `npx @electron/rebuild -f -w node-pty` if the native module isn't built yet.
2. Detects whether the bundled `chrome-sandbox` is setuid root and adds `--no-sandbox` if not.
3. Reaps stale Electron processes whose `--app-path` matches this source dir (so a hard kill from a prior run doesn't pile up inotify watchers).
4. Warns if `fs.inotify.max_user_instances` is below 256 with the `sysctl` fix.
5. Spawns Husk in dev mode (no system registration).

For a system-registered install (Linux `.desktop` entry / macOS `.app` bundle / OS file associations), use `./install.sh` instead.

## Repo layout

See [`architecture.md`](architecture.md) for the full tree. The tl;dr:

```
src/main.js          electron main process (IPC, PTY, agent control)
src/preload.js       contextBridge surface
src/renderer/        UI (single-page Electron view + xterm.js)
libs/pai/            bundled PAI framework (third-party)
installer/           OS install assets + curated default prompts
docs/                you are here
.github/             CI: security, release, dependabot
```

## Conventional Commits, with scope

Every commit message is `type(scope): short description`. Examples:

```
fix(pty): use sh -c on macOS, BSD script(1) rejects -c
feat(rail): add Recent sessions section under Workspace
chore(repo): move app code to src/, third-party to libs/
docs(readme): trim credits to one paragraph
style(rail): drop green dot from agent pill
perf(renderer): narrow `transition: all` to specific properties
```

Allowed types: `feat` `fix` `chore` `docs` `style` `refactor` `perf` `test` `build`.

Common scopes: `mcp`, `rail`, `chat`, `skills`, `sessions`, `voice`, `prefs`, `installer`, `readme`, `agent-pill`, `topbar`, `status-panel`, `pai`, `ci`, `release`, `pty`, `bootstrap`, `ui`, `palette`, `onboarding`, `prompts`, `updates`.

Subject rules: lowercase first word after the colon, no period at the end, imperative mood, ≤72 chars. Body is optional and explains the *why* (the diff already shows the *what*). No em dashes anywhere.

Multiple unrelated scopes? Split into multiple commits.

## CI gates

Two workflows fire on every push and PR (`.github/workflows/`):

### `ci.yml`

- `node --check` on `src/main.js`, `src/preload.js`, `src/renderer/app.js`
- `bash -n` on `install.sh`, `run.sh`, `uninstall.sh`
- `package.json` and `package-lock.json` JSON validity
- `npm ci --dry-run` to catch lockfile drift

### `security.yml`

| Job | Tool | Fail on |
|-----|------|---------|
| Secret detection | gitleaks 8.22 | any leaked secret in the diff or full history |
| Dependency audit | `npm audit --audit-level=high` | high or critical advisory |
| JavaScript security | ESLint with `eslint-plugin-security` + `eslint-plugin-no-unsanitized` | `error`-level rule (eval, unsafe-regex, non-literal-require, etc.) |
| CodeQL | `security-extended` + `security-and-quality` query suites | new alert |
| Semgrep | OWASP Top 10 + JS + Node + XSS + Command Injection rule packs | any ERROR severity finding |
| Trivy | filesystem CVE scan | HIGH or CRITICAL on a library |

Plus a summary job that posts results to the PR comment.

A failing job blocks the PR. A failing CodeQL alert blocks until either the code is fixed (preferred) or the alert is dismissed with a written justification on the GitHub Security tab.

## Release pipeline

Releases are tag-driven (`.github/workflows/release.yml`).

```bash
git tag v0.3.1
git push origin v0.3.1
```

The workflow then:

1. Matrix-builds on `ubuntu-latest`, `macos-latest`, `windows-latest`.
2. Each runner: `npm ci`, then `npm run dist` (electron-builder, `--publish never` so we control the publish step).
3. Uploads platform artifacts as workflow artifacts.
4. A final `release` job downloads everything, flattens into one folder, and creates the GitHub Release with `softprops/action-gh-release@v2` and auto-generated notes.

The `--publish never` flag is intentional. electron-builder used to also publish on its own, which produced a double "Full Changelog" line on the release page (one from electron-builder, one from softprops). softprops is the single writer.

`electron-updater` (in-app auto-update) reads from the same Releases page; the `publish` block in `package.json` tells it `provider: github, owner: DorShaer, repo: Husk`.

## Dependency policy

`.github/dependabot.yml` opens weekly grouped PRs:
- npm: minor + patch only, never auto-bumps a major (Electron / xterm / node-pty majors all change ABI or wire format).
- github-actions: minor + patch only.
- Security advisories from GitHub still flow through their own pipeline regardless of these ignore rules.

Major bumps must be human-authored. Pin actions and external tools (gitleaks, trivy) by SHA when available.

## What not to do

- Don't add a feature flag for "future configurability". Add it when there's a second use case.
- Don't auto-push. Commit locally; the user pushes when they validate. Repo standard.
- Don't bake user-specific examples (real product names, customer URLs, API keys from chat) into code or commit messages. Use `my-server`, `example.com`, `Bearer ...`, `<server-id>`.
- Don't break the renderer-isolation contract: never weaken `contextIsolation: true`, never add `nodeIntegration: true`, never widen the CSP `script-src` past `'self'`.
- Don't introduce em dashes in any code, comment, doc, or commit message.

## Reporting a vulnerability

See [`../SECURITY.md`](../SECURITY.md). Email, do not file a public issue.
