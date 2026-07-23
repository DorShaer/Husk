# Contributing

Quick reference for working on Husk. Skim once before sending your first PR.

## Dev setup

```bash
git clone https://github.com/DorShaer/Husk.git husk
cd husk
./scripts/run.sh
```

`run.sh`:
1. Runs `npm install` and `npx @electron/rebuild -f -w node-pty` if the native module is not built yet.
2. Detects whether the bundled `chrome-sandbox` is setuid root and adds `--no-sandbox` if not.
3. Reaps stale Electron processes whose `--app-path` matches this source dir (so a hard kill from a prior run does not pile up inotify watchers).
4. Warns if `fs.inotify.max_user_instances` is below 256 with the `sysctl` fix.
5. Spawns Husk in dev mode (no system registration).

For a system-registered install (Linux `.desktop` entry, macOS `.app` bundle, OS file associations), use `./installer/install.sh` instead.

## Repo layout

See [`architecture.md`](architecture.md) for the full tree. The tl;dr:

```
src/main.js          electron main process (IPC, PTY, agent control)
src/preload.js       contextBridge surface
src/lib/             pure helpers (shell-quote, path-confine, pty-spawn, workflow-graph, mcp/)
src/renderer/        UI (single-page Electron view + xterm.js)
libs/lifeos/         bundled LifeOS framework (third-party)
installer/           OS install assets, default prompts, verify.sh / verify.ps1
test/unit/           node:test unit tests against src/lib/
test/e2e/            Playwright smoke (real Electron boot)
docs/                you are here
.github/             CI: lint, security, release, dependabot
```

## Branching model

- `main` carries released code. Tags `v*` are cut from here, the release workflow builds installers, and `SHA256SUMS` plus Sigstore build-provenance attestations ship alongside them.
- `development` is the integration branch where active work lands. Feature branches use `dev/<short-name>` and open pull requests against `development`.
- Releases merge `development` into `main`, then a `v<x>.<y>.<z>` tag triggers the release pipeline.
- CI (lint, security scans, unit tests, Electron smoke) runs on every push and pull request to either long-lived branch.

## Testing

```bash
npm test         # node:test unit tests against src/lib/, runs in well under a second
npm run test:e2e # Playwright smoke that boots real Electron
npm run test:all # both
```

The unit suite is the fast feedback loop. New pure helpers go under `src/lib/` and ship with a matching `test/unit/<helper>.test.js`. Avoid wiring Electron, `fs`, or `spawn` directly into a helper if you want the unit suite to cover it; main-process IPC glue stays in `src/main.js`.

## Conventional Commits, with scope

Every commit message is `type(scope): short description`. Examples:

```
feat(rail): add Recent sessions section under Workspace
fix(mcp): parse the current claude mcp list output format
refactor(mcp): per-agent adapters so MCP page matches the active agent
chore(release): clean artifact names husk-vX-os-arch.ext
docs(readme): trim credits to one paragraph
style(rail): drop green dot from agent pill
perf(renderer): narrow `transition: all` to specific properties
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`.

Common scopes: `mcp`, `rail`, `chat`, `skills`, `sessions`, `voice`, `prefs`, `installer`, `readme`, `agent-pill`, `topbar`, `status-panel`, `pai`, `ci`, `release`, `pty`, `bootstrap`, `ui`, `palette`, `onboarding`, `prompts`, `updates`, `workflows`, `profiles`, `projects`.

Subject rules: lowercase first word after the colon, no period at the end, imperative mood, 72 chars or fewer. Body is optional and explains the *why* (the diff already shows the *what*). No em dashes anywhere.

Multiple unrelated scopes? Split into multiple commits.

## CI gates

Three workflows fire on every push to `main`, `development`, and `dev/**`, and on every pull request to `main` or `development` (`.github/workflows/`):

### `ci.yml`

- `node --check` on `src/main.js`, `src/preload.js`, `src/renderer/app.js`
- `bash -n` on `install.sh`, `run.sh`, `uninstall.sh`
- `package.json` and `package-lock.json` JSON validity
- `npm ci --dry-run` to catch lockfile drift

### `tests.yml`

- `npm test` against `test/unit/` (node:test)
- `npm run test:e2e` (Playwright smoke against a real Electron boot)

### `security.yml`

| Job | Tool | Fail on |
|-----|------|---------|
| Secret detection | gitleaks 8.22 | any leaked secret in the diff or full history |
| Dependency audit | `npm audit --audit-level=high` | high or critical advisory |
| JavaScript security | ESLint with `eslint-plugin-security` and `eslint-plugin-no-unsanitized` | `error`-level rule (eval, unsafe-regex, non-literal-require, etc.) |
| CodeQL | `security-extended` + `security-and-quality` query suites | new alert |
| Semgrep | OWASP Top 10 + JavaScript + Node rule packs | any ERROR severity finding |
| Trivy | filesystem CVE scan | HIGH or CRITICAL on a library |

Plus a summary job that posts results to the PR comment.

A failing job blocks the PR. A failing CodeQL alert blocks until either the code is fixed (preferred) or the alert is dismissed with a written justification on the GitHub Security tab.

## Release pipeline

Releases are tag-driven (`.github/workflows/release.yml`).

```bash
# from main, after development has merged in
git tag -a vX.Y.Z --cleanup=verbatim -F /tmp/vX.Y.Z-notes.md
git push origin vX.Y.Z
```

The notes file starts with a one-line tag subject, a blank line, then the
public release body. Keep the body user-facing and version-specific.

The workflow then:

1. Matrix-builds on `ubuntu-latest`, `macos-latest`, `windows-latest`.
2. Each runner: `npm ci`, then `npm run dist` (electron-builder, `--publish never` so we control the publish step).
3. Uploads platform artifacts as workflow artifacts.
4. A final `release` job downloads everything, flattens into one folder, generates `SHA256SUMS`, and signs every artifact with `actions/attest-build-provenance`.
5. Checks out the repo at the tag, verifies the tag is annotated, reads the tag message into `/tmp/release-notes.md`, and hands it to `softprops/action-gh-release@v2` as `body_path`. `generate_release_notes` is `false`.

The body that lands on the Releases page is exactly what you wrote in the `git tag -a` message. No auto-generated PR list, no electron-builder publish noise.

`electron-updater` (in-app auto-update) reads from the same Releases page; the `publish` block in `package.json` tells it `provider: github, owner: DorShaer, repo: Husk`.

Artifact filenames are pinned in `package.json` per target: `husk-v${version}-${os}-${arch}.${ext}`.

## Dependency policy

`.github/dependabot.yml` opens weekly grouped PRs:
- npm: minor and patch only, never auto-bumps a major (Electron, xterm, and node-pty majors all change ABI or wire format).
- github-actions: minor and patch only. Actions are pinned by commit SHA.
- Security advisories from GitHub still flow through their own pipeline regardless of these ignore rules.

Major bumps must be human-authored. Pin actions and external tools (gitleaks, trivy) by SHA when available.

## What not to do

- Don't add a feature flag for "future configurability". Add it when there is a second use case.
- Don't auto-push. Commit locally; the user pushes when they validate.
- Don't bake user-specific examples (real product names, customer URLs, API keys from chat) into code or commit messages. Use `my-server`, `example.com`, `Bearer ...`, `<server-id>`.
- Don't break the renderer-isolation contract: never weaken `contextIsolation: true`, never add `nodeIntegration: true`, never widen the CSP `script-src` past `'self'`, never re-enable DevTools in packaged builds.
- Don't introduce em dashes in any code, comment, doc, or commit message.

## Reporting a security issue

See [`../SECURITY.md`](../SECURITY.md). Email, do not file a public issue.
