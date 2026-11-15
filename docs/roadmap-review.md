# Development review

This change set adds chat continuation, explicit Brain rules, usage warnings and budgets, appearance controls, and reviewed local sharing. It includes the subsequent fixes verified during local review. No version bump or release is included.

## Included

- New-chat menus name the installed CLIs. Composer CLI and folder chips support starting fresh or carrying a discussion into another session.
- Native chat transcripts are stored privately with configurable retention. Injected Brain and handoff context stays out of restored bubbles and session titles.
- Brain rules are created explicitly, scoped globally or by workspace, and applied independently of recalled reference notes. Their enabled state and overflow are visible.
- Usage readings cover available plan, context and local daily-budget data. The badge clears when viewed; acknowledgement survives reloads, and reset-estimate drift does not repeat the same toast.
- Codex questions use selectable cards and typed answers, including non-blocking requests, dismissal, reload recovery and withdrawal. Allow all never answers questions automatically.
- The theme registry contains 19 themes, including eight added palettes. There are four added accents, custom accents, and privately stored background images with bounded input and isolated re-encoding.
- Sharing supports local bundle import/export, optional Ed25519 publisher signatures, an external scanner, and installation review for bundles, agent packs, workflow artifacts and pasted MCP sets. Selected files are read through checked bounded descriptors; staged content is checked again after scanning and before installation.
- Sessions uses the v2.13.2 page, actions, selected-tool loading and 300-row display cap. A row-sizing correction prevents long titles from overlapping. The shared chat/search history still benefits from classification before the source cap and resolved project paths.
- The right-panel file action is hidden in Native Chat and retained in Agent terminal mode. Composer menus are anchored to their chips.

## Validation

- Unit suite: 1,931 passed.
- Stability profile: passed navigation, all 19 themes, tab churn, terminal flood, list repaints and idle checks. Renderer heap stayed at 15.4 MiB; final whole-app working set was 689 MiB against a 667 MiB baseline. These are local observations, not cross-machine guarantees.
- Linux AppImage: built successfully. Its isolated packaged-app checks passed chat, usage, background re-encoding and private transcripts. The archive was also checked for excluded files and handlers.
- Complete UI suite: all 303 checks passed in one run (17.1 minutes), with no retries. The focused sharing/API-boundary check also passed.
- Syntax: all 65 changed JavaScript files passed `node --check`; package, lockfile and impact-map JSON parsed successfully.

Linux automated GUI runs use X11 under Xvfb and isolated profiles. The test harness disables the OS sandbox. Native sandbox enforcement, real provider accounts, Windows and macOS require their own environments; these checks do not establish coverage of every platform or theme/surface combination.

## Limits

- Sharing uses local files. Hosted discovery, publisher accounts and team synchronization are not part of this change set.
- A signature identifies a publisher key; it does not prove an artifact safe. Declared permissions are not OS enforcement.
- Wolf is a separately selected local executable and is not bundled. Its artifact fixture results do not establish exhaustive detection or broad false-positive rates.
- Terminal-only CLIs receive handoff text through paste; they do not gain native history readers or normalized terminal transcripts.
- Agent processes remain responsible for following Brain rules. Existing terminal sessions need a restart to receive updated instructions.
- Dollar budgets use estimates observed in Husk and exclude usage in other applications. They are reminders, not provider billing controls.
- Speech-to-text issue 139 remains deferred. Left-panel resizing is not included.

## Reproduce

With dependencies installed:

```sh
npm test
npm run test:e2e
npm run test:perf
node node_modules/electron-builder/cli.js --linux AppImage --publish never -c.productName=husk
xvfb-run --auto-servernum --server-args='-screen 0 1920x1200x24' node scripts/verify-linux-package.js dist/linux-unpacked
```

See [the import audit](../audit_local_imports.md), [chat, rules and usage](chat-continuation.md), and [local sharing](local-sharing.md).
